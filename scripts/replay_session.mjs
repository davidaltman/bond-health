#!/usr/bin/env node
/**
 * Replays scripted transcripts through the live session endpoints, turn by
 * turn, and asserts on what the agent knew and what it decided.
 *
 * This is the acceptance harness for Phases 1-3. It asserts on *state and
 * decisions*, never on wording: an outcome of HANDOFF either happened or it
 * didn't, whereas "was the phrasing empathetic" can only be scored softly and
 * can't gate a change. Prose quality is a separate, weaker signal.
 *
 * Scenarios declare their own expectations, so adding a case is a JSON file
 * rather than a code change -- which is the point, since the loop this is
 * building toward is "a flagged live turn becomes a new eval case."
 *
 * Usage:
 *   node scripts/replay_session.mjs harness_inputs/colonoscopy_never_screened.json
 *   node scripts/replay_session.mjs harness_inputs/*.json
 *   SERVER=http://127.0.0.1:8790 node scripts/replay_session.mjs <files...>
 */
import { readFile } from "node:fs/promises";

const SERVER = process.env.SERVER || "http://127.0.0.1:8790";

async function json(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) throw new Error(`${options?.method ?? "GET"} ${url} -> ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node scripts/replay_session.mjs <scenario.json> [more.json ...]");
  process.exit(2);
}

async function runScenario(file) {
  const scenario = JSON.parse(await readFile(file, "utf8"));
  // harness_inputs/ also holds fixtures for the older post-call harness, so a
  // glob over the directory shouldn't blow up on them.
  if (!Array.isArray(scenario.turns)) {
    console.log(`\nSKIP  ${file} — not a replay scenario (no turns array)`);
    return null;
  }
  console.log(`\n${"=".repeat(78)}\nSCENARIO  ${scenario.name}\n${scenario.description ?? ""}\n`);

  const { sessionId } = await json(`${SERVER}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ patientName: scenario.patientName, patientAge: scenario.patientAge }),
  });

  const checks = [];
  const seenOutcomes = [];

  // Text mode drives the real product path: only the patient speaks, and
  // Daphne's replies come from the decision engine rather than from a script.
  // Scripted-agent mode stays available because pinning both sides is the only
  // way to steer a conversation to a specific gate on demand.
  if (scenario.mode === "text") {
    for (const turn of scenario.turns.filter((t) => t.role === "user")) {
      const started = Date.now();
      const result = await json(`${SERVER}/api/session/${sessionId}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: turn.content }),
      });
      const decision = result.decision;
      if (decision) seenOutcomes.push(decision.outcome);

      console.log(`patient  ${turn.content}`);
      for (const applied of result.applied) {
        console.log(`         · ${applied.outcome} ${applied.factId ?? ""} ${applied.detail}`.trimEnd());
      }
      console.log(
        `         [${decision?.outcome} via ${decision?.gate}]  (${Date.now() - started}ms)`,
      );
      console.log(`daphne   ${result.reply.text}\n`);

      if (turn.expectOutcome) {
        checks.push({
          name: `"${turn.content.slice(0, 44)}…" → ${turn.expectOutcome}${turn.expectGate ? ` via ${turn.expectGate}` : ""}`,
          pass:
            decision?.outcome === turn.expectOutcome &&
            (!turn.expectGate || decision?.gate === turn.expectGate),
          got: decision ? `${decision.outcome} via ${decision.gate}` : "no decision",
        });
      }

      // The safety property the two-part reply exists to provide: authored
      // clinical wording reaches the patient character for character, and the
      // model's contribution is only ever prepended warmth.
      if (result.reply.substance) {
        checks.push({
          name: "authored clinical wording survived verbatim into the reply",
          pass: result.reply.text.includes(result.reply.substance),
          got: result.reply.text,
        });
      }
      if (result.reply.acknowledgment) {
        checks.push({
          name: "acknowledgment carries no numbers",
          pass: !/\d/.test(result.reply.acknowledgment),
          got: result.reply.acknowledgment,
        });
      }
    }
    return finish(scenario, sessionId, checks, seenOutcomes);
  }

  for (const turn of scenario.turns) {
    const started = Date.now();
    const result = await json(`${SERVER}/api/session/${sessionId}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: turn.role, content: turn.content }),
    });
    const ms = Date.now() - started;
    const who = turn.role === "agent" ? "daphne " : "patient";
    console.log(`[${String(result.turnIndex).padStart(2)}] ${who}  ${turn.content.slice(0, 76)}`);

    for (const applied of result.applied) {
      console.log(`         · ${applied.outcome} ${applied.factId ?? ""} ${applied.detail}`.trimEnd());
    }

    if (turn.role !== "user") continue;

    const s = result.signals;
    console.log(
      `         signals: tone=${s?.tone} hesitation=${s?.hesitation} readiness=${s?.readiness} request=${s?.requestType}  (${ms}ms)`,
    );

    const decision = result.decision;
    if (decision) {
      seenOutcomes.push(decision.outcome);
      console.log(`         DECISION ${decision.outcome} via ${decision.gate} — ${decision.reason}`);
      if (decision.say) {
        console.log(`         say: "${decision.say.slice(0, 96)}${decision.say.length > 96 ? "…" : ""}"`);
      }
    }

    // Per-turn expectations, declared inline in the scenario.
    if (turn.expectOutcome) {
      checks.push({
        name: `turn ${result.turnIndex}: expected ${turn.expectOutcome}${turn.expectGate ? ` via ${turn.expectGate}` : ""}`,
        pass:
          decision?.outcome === turn.expectOutcome &&
          (!turn.expectGate || decision?.gate === turn.expectGate),
        got: decision ? `${decision.outcome} via ${decision.gate}` : "no decision",
      });
    }
  }

  return finish(scenario, sessionId, checks, seenOutcomes);
}

/** Shared reporting and assertions for both replay modes. */
async function finish(scenario, sessionId, checks, seenOutcomes) {
  const state = await json(`${SERVER}/api/session/${sessionId}`);
  const live = state.facts;

  console.log("\n--- ledger ---");
  for (const fact of state.allFacts) {
    const q = fact.qualifiers;
    const age = q.onsetAge != null ? ` onset=${q.onsetAge}` : "";
    const dead = fact.state === "asserted" || fact.state === "confirmed" ? "" : `  [${fact.state}]`;
    console.log(
      `${fact.id}  ${fact.subject.padEnd(8)} ${fact.category.padEnd(14)} ${fact.attribute.padEnd(24)} status=${q.status}${age}${dead}`,
    );
  }
  if (state.resolution) {
    console.log(
      `\n--- resolution ---\n${
        state.resolution.status === "booked"
          ? `booked ${state.resolution.booking.confirmationId} at ${state.resolution.booking.slot.clinic}, ${state.resolution.booking.slot.daysOut} days out`
          : `waitlisted ${state.resolution.waitlistId} — ${state.resolution.reason}`
      }`,
    );
  }

  // --- invariants that must hold in every scenario -------------------------
  checks.push({
    name: "no duplicate subject:attribute in the live ledger",
    pass: (() => {
      const keys = live.map((f) => `${f.subject.toLowerCase()}:${f.attribute.toLowerCase()}`);
      return new Set(keys).size === keys.length;
    })(),
  });
  checks.push({
    name: "every fact carries a source quote",
    pass: state.allFacts.every((f) => typeof f.sourceQuote === "string" && f.sourceQuote.trim()),
  });
  checks.push({
    name: "facts about relatives are categorized family_history",
    pass: live.filter((f) => f.subject !== "self").every((f) => f.category === "family_history"),
  });
  checks.push({
    name: "every patient turn produced a decision",
    pass: seenOutcomes.length === scenario.turns.filter((t) => t.role === "user").length,
    got: `${seenOutcomes.length} decisions`,
  });

  // --- scenario-declared expectations --------------------------------------
  const expect = scenario.expect ?? {};

  if (expect.finalOutcome) {
    const final = state.decision?.outcome;
    checks.push({
      name: `final outcome is ${expect.finalOutcome}`,
      pass: final === expect.finalOutcome,
      got: `${final} via ${state.decision?.gate}`,
    });
  }

  for (const forbidden of expect.neverOutcome ?? []) {
    checks.push({
      name: `never decides ${forbidden} at any point`,
      pass: !seenOutcomes.includes(forbidden),
      got: seenOutcomes.join(" → "),
    });
  }

  if (expect.resolution) {
    const actual = state.resolution?.status ?? "none";
    checks.push({
      name: `resolution is "${expect.resolution}"`,
      pass: actual === expect.resolution,
      got: actual,
    });
  }

  if (expect.confirmationId) {
    checks.push({
      name: "booking returned a confirmation id",
      pass: Boolean(state.resolution?.booking?.confirmationId),
      got: state.resolution?.booking?.confirmationId ?? "none",
    });
  }

  // Pins down the scheduling-preference bug: a reply that both states a day/
  // time AND uses an affirmation phrase ("works for me") must not silently
  // fall back to "soonest, matched" -- see preference.ts's AMBIGUOUS_SOONEST
  // handling. `false` here means "closest available, not exact," which is
  // the honest outcome for a preference this scenario's mock calendar has no
  // exact slot for.
  if (typeof expect.matchedPreference === "boolean") {
    const booked = state.resolution?.status === "booked";
    checks.push({
      name: `booking ${expect.matchedPreference ? "exactly matched" : "did not exactly match"} the stated preference`,
      pass: booked && state.resolution.matchedPreference === expect.matchedPreference,
      got: booked ? `matchedPreference=${state.resolution.matchedPreference}` : (state.resolution?.status ?? "none"),
    });
  }

  for (const wanted of expect.facts ?? []) {
    const matcher = new RegExp(wanted.match, "i");
    const found = live.find(
      (f) =>
        (!wanted.subject || f.subject === wanted.subject) &&
        matcher.test(`${f.attribute} ${f.value}`) &&
        (!wanted.status || f.qualifiers.status === wanted.status) &&
        (wanted.onsetAge === undefined || f.qualifiers.onsetAge === wanted.onsetAge),
    );
    checks.push({
      name: `fact: ${wanted.subject ?? "any"} /${wanted.match}/${wanted.status ? ` status=${wanted.status}` : ""}${
        wanted.onsetAge !== undefined ? ` onset=${wanted.onsetAge}` : ""
      }`,
      pass: Boolean(found),
      got: found ? found.id : "not found",
    });
  }

  for (const unwanted of expect.noFacts ?? []) {
    const matcher = new RegExp(unwanted.match, "i");
    const found = live.find(
      (f) =>
        (!unwanted.subject || f.subject === unwanted.subject) &&
        matcher.test(`${f.attribute} ${f.value}`) &&
        (unwanted.onsetAge === undefined || f.qualifiers.onsetAge === unwanted.onsetAge),
    );
    checks.push({
      name: `no fact: ${unwanted.subject ?? "any"} /${unwanted.match}/${
        unwanted.onsetAge !== undefined ? ` onset=${unwanted.onsetAge}` : ""
      }`,
      pass: !found,
      got: found ? `${found.id} exists` : "absent",
    });
  }

  console.log("\n--- acceptance ---");
  let failed = 0;
  for (const check of checks) {
    if (!check.pass) failed++;
    const suffix = !check.pass && check.got ? `  (got: ${check.got})` : "";
    console.log(`${check.pass ? "PASS" : "FAIL"}  ${check.name}${suffix}`);
  }

  const errors = state.trace.filter((event) => event.kind === "extraction_failed");
  for (const error of errors) console.log(`  ! turn ${error.turn} extraction failed: ${error.detail}`);

  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  return { name: scenario.name, total: checks.length, failed };
}

const results = [];
for (const file of files) {
  const result = await runScenario(file);
  if (result) results.push(result);
}

console.log(`\n${"=".repeat(78)}\nSUMMARY`);
let totalFailed = 0;
for (const result of results) {
  totalFailed += result.failed;
  console.log(
    `${result.failed ? "FAIL" : "PASS"}  ${result.name.padEnd(40)} ${result.total - result.failed}/${result.total}`,
  );
}
process.exit(totalFailed ? 1 : 0);
