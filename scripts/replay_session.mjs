#!/usr/bin/env node
/**
 * Replays a scripted transcript through the live session endpoints, turn by
 * turn, and checks the resulting ledger.
 *
 * This is the Phase 1 acceptance harness. It asserts on the *state* the
 * conversation produced, not on any wording -- the same discipline the eval
 * suite in Phase 6 will use, because prose scores can't gate a change and
 * state assertions can.
 *
 * Usage:
 *   node scripts/replay_session.mjs harness_inputs/colonoscopy_never_screened.json
 *   SERVER=http://127.0.0.1:8790 node scripts/replay_session.mjs <file>
 */
import { readFile } from "node:fs/promises";

const SERVER = process.env.SERVER || "http://127.0.0.1:8790";

async function json(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) throw new Error(`${options?.method ?? "GET"} ${url} -> ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/replay_session.mjs <scenario.json>");
  process.exit(2);
}

const scenario = JSON.parse(await readFile(file, "utf8"));
console.log(`scenario: ${scenario.name}`);
console.log(`server:   ${SERVER}\n`);

const { sessionId } = await json(`${SERVER}/api/session`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ patientName: scenario.patientName, patientAge: scenario.patientAge }),
});

for (const turn of scenario.turns) {
  const started = Date.now();
  const result = await json(`${SERVER}/api/session/${sessionId}/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(turn),
  });
  const ms = Date.now() - started;
  const who = turn.role === "agent" ? "daphne " : "patient";
  console.log(`[${String(result.turnIndex).padStart(2)}] ${who}  ${turn.content.slice(0, 78)}`);
  for (const applied of result.applied) {
    console.log(`         -> ${applied.outcome} ${applied.factId ?? ""} ${applied.detail}`.trimEnd());
  }
  if (turn.role === "user") {
    const s = result.signals;
    console.log(
      `         signals: tone=${s?.tone} hesitation=${s?.hesitation} readiness=${s?.readiness}  (${ms}ms)`,
    );
  }
}

const state = await json(`${SERVER}/api/session/${sessionId}`);

console.log("\n=== ledger ===");
for (const fact of state.allFacts) {
  const q = fact.qualifiers;
  const age = q.onsetAge != null ? ` onset=${q.onsetAge}` : "";
  const dead = fact.state === "asserted" || fact.state === "confirmed" ? "" : `  [${fact.state}]`;
  console.log(
    `${fact.id}  ${fact.subject.padEnd(8)} ${fact.category.padEnd(14)} ${fact.attribute.padEnd(22)} status=${q.status}${age}  ${fact.confidence}${dead}`,
  );
}

// --- acceptance checks -----------------------------------------------------
const live = state.facts;
const all = state.allFacts;
const findLive = (pred) => live.find(pred);

const checks = [
  {
    name: "explicit negative is recorded as a fact with status 'never', not as silence",
    pass: () =>
      Boolean(
        findLive(
          (f) =>
            f.subject.toLowerCase() === "self" &&
            /colonoscop|screen/i.test(`${f.attribute} ${f.value}`) &&
            f.qualifiers.status === "never",
        ),
      ),
  },
  {
    name: "self-correction marks the original fact contradicted or superseded",
    pass: () => all.some((f) => f.state === "contradicted" || f.state === "superseded"),
  },
  {
    name: "corrected age (52) is what survives, not the original (60)",
    pass: () => {
      const father = live.filter((f) => /father/i.test(f.subject));
      return father.some((f) => f.qualifiers.onsetAge === 52) && !father.some((f) => f.qualifiers.onsetAge === 60);
    },
  },
  {
    name: "restating a known fact does not create a duplicate subject:attribute",
    pass: () => {
      const keys = live.map((f) => `${f.subject.toLowerCase()}:${f.attribute.toLowerCase()}`);
      return new Set(keys).size === keys.length;
    },
  },
  {
    name: "a relative's condition is categorized as family_history, not as the patient's own",
    pass: () => live.filter((f) => f.subject !== "self").every((f) => f.category === "family_history"),
  },
  {
    name: "final turn moves readiness to explicit_request",
    pass: () => state.signals?.readiness === "explicit_request",
  },
  {
    name: "every fact carries a source quote",
    pass: () => all.every((f) => typeof f.sourceQuote === "string" && f.sourceQuote.trim().length > 0),
  },
];

console.log("\n=== acceptance ===");
let failed = 0;
for (const check of checks) {
  let ok = false;
  try {
    ok = check.pass();
  } catch {
    ok = false;
  }
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${check.name}`);
}

const failures = state.trace.filter((event) => event.kind === "extraction_failed");
if (failures.length) {
  console.log(`\n${failures.length} extraction failure(s):`);
  for (const failure of failures) console.log(`  turn ${failure.turn}: ${failure.detail}`);
}

console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
