# Ticket: replace regex-only closing/details detection with LLM-first classification

**Type:** Architecture improvement (not a bug — current behavior works for
its covered phrase list, this closes gaps in that list without weakening
`decide()`'s purity guarantee).

**Where:** `server/src/decide.ts`'s `already_resolved` gate
(`CLOSING_PATTERN` / `BOOKING_DETAIL_PATTERN`).

This doc is self-contained so a fresh agent session can implement it without
needing the chat that produced it.

---

## 1. The problem

The `already_resolved` gate (gate 3 in `decide.ts`'s fixed order) has to
tell apart three things once a booking or waitlist exists: a farewell, a
request for booking details ("what's the date again?"), and everything
else. It does this with two hardcoded regexes:

```92:119:server/src/decide.ts
const BOOKING_DETAIL_PATTERN = /\b(date|when|day|time|calendar|confirm(ation|ed)?|clinic|where)\b/i;
...
const CLOSING_PATTERN =
  /\b(?:that'?s (?:it|all)|nothing else|no,? thanks?(?: you)?|i'?m (?:good|all set|all done|done)|we'?re (?:good|all set|done)|no more questions)\b/i;
```

Both are fixed phrase lists. Unlike a genuinely closed vocabulary (weekday
names, phone-number shape — see `docs/interview-prep.md` Module 9), the
space of ways a patient can say "I'm done" or "remind me when that is" is
open-ended. Real phrasing this pair would currently miss, none of which
match either pattern: *"I think that covers it,"* *"nope, all set for now,"*
*"cool, appreciate it,"* *"remind me where I'm headed again?"*,
*"who's it with?"* A missed farewell falls through to the generic
"you're all set" line repeating; a missed details-question does the same
instead of actually answering it — not a crash, but a worse conversational
experience than the gate is capable of.

## 2. The constraint this has to respect

`decide()` must remain a **pure, synchronous, zero-model-call function** —
this is the single most load-bearing architectural property in this
codebase (see `docs/interview-prep.md` Module 1, and `decide.ts`'s own
top-of-file comment). It's what lets `scripts/replay_session.mjs` /
`harness_inputs/*.json` assert exact, deterministic `gate`/`outcome`
expectations per turn, and it's why every current call site treats
`decide()` as instantaneous and infallible (no `await`, no `try/catch`
around it in `sessions.ts`).

**Do not add an LLM call inside `decide()`.** That would:
- reintroduce run-to-run nondeterminism into the eval harness's hardest
  assertions,
- force `decide()` to become `async` and every caller to be restructured
  around a decision that can now fail or hang,
- violate the "model decides facts, code decides what happens" split this
  whole architecture is built on (see `requirements.ts`/`ledger.ts` header
  comments) — which gate fires is squarely on the "what happens" side.

## 3. The existing precedent to follow instead

This codebase already solves this exact class of problem twice, for the
`scheduling`/`escort`/`shipping` gates: `server/src/logistics-llm.ts`'s
`classifySoonestPreference` and `classifyDecline`. Both are real LLM calls
needed to influence gate behavior, and both live **entirely outside**
`decide()`:

```228:266:server/src/sessions.ts
      const priorGate = session.decisions.at(-1)?.gate ?? null;
      const expectingSchedulingPreference = session.bookingRequested && !session.schedulingPreference;
      const expectingEscort = priorGate === "escort" && !session.escortContact;
      const expectingShipping = priorGate === "shipping" && !session.shippingAddress;

      const logisticsCall: Promise<
        { kind: "soonest"; soonestOk: boolean } | { kind: "decline"; declined: boolean } | null
      > = expectingSchedulingPreference
        ? classifySoonestPreference({ question: precedingAgentTurn, reply: content }).then(...)
        : expectingEscort
          ? classifyDecline({ askedFor: "escort_contact", ... }).then(...)
          : expectingShipping
            ? classifyDecline({ askedFor: "shipping_address", ... }).then(...)
            : Promise.resolve(null);

      const [extraction, logisticsJudgment] = await Promise.all([
        extractTurn({ ... }),
        logisticsCall.catch((error) => { /* trace + fall back to null */ return null; }),
      ]);
```

Key properties of this pattern, all of which the new classifier should
copy exactly:

1. **Fired conditionally**, only when the currently active gate makes the
   judgment relevant — an ordinary clinical-history turn pays zero latency
   or cost for this.
2. **Run concurrently with `extractTurn`** via `Promise.all`, not
   sequentially — the "is this call relevant" decision is knowable from
   state that doesn't depend on this turn's extraction (here: whether the
   session is `alreadyResolved`, which is already known before extraction
   runs).
3. **Own `.catch()`, isolated from the main extraction failure path** — a
   failed logistics call must never take down the turn's otherwise-successful
   extraction.
4. **Result becomes plain, already-resolved data** passed into `decide()`
   via `DecisionInput` — `decide()` itself never calls out anywhere; it
   only reads a value that was already decided upstream.
5. **Regex stays as the fallback**, not deleted — see `UNAMBIGUOUS_SOONEST_
   PATTERN` / `DECLINE_PATTERN` still present in `preference.ts`/
   `escort.ts`/`shipping.ts`. If the call fails or wasn't made, callers
   degrade to the old keyword match rather than losing the signal entirely.

## 4. Proposed implementation

**4.1 — `server/src/logistics-llm.ts`**: add a new classifier,
`classifyClosingIntent`, modeled directly on `classifyDecline`:

```ts
const CLOSING_SYSTEM_PROMPT = `A scheduling assistant already told the patient about their existing
booking or waitlist entry. Judge what THIS reply means.

Answer "closing" if the patient is signaling they're done -- a goodbye, a
plain thank-you with nothing further, or an indication there's nothing else
they need.

Answer "details" if the patient is asking for something about their existing
booking/waitlist itself -- the date, time, clinic, confirmation number, or
similar -- even if phrased indirectly ("where am I headed again?", "who's it
with?", "remind me when that is").

Answer "other" for anything else -- a new question, a change of topic, or
something that doesn't fit either category.

Output only JSON matching the schema.`;

const CLOSING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: { type: "string", enum: ["closing", "details", "other"] },
  },
  required: ["intent"],
};

export interface ClosingIntentJudgment {
  intent: "closing" | "details" | "other";
}

export async function classifyClosingIntent(input: {
  reply: string;
}): Promise<ClosingIntentJudgment> {
  const raw = await completeJson<{ intent: "closing" | "details" | "other" }>({
    system: CLOSING_SYSTEM_PROMPT,
    user: `PATIENT REPLY\n${input.reply}`,
    schemaName: "closing_intent",
    schema: CLOSING_SCHEMA,
    maxOutputTokens: 256,
    reasoningEffort: "none",
  });
  return { intent: raw.intent ?? "other" };
}
```

**4.2 — `server/src/sessions.ts`**: add a fourth conditional branch to the
existing `logisticsCall` ternary, gated on `session.resolution != null`
(mirrors `alreadyResolved` in `decide.ts`'s `DecisionInput`):

```ts
const expectingClosingIntent = session.resolution != null;
...
: expectingClosingIntent
  ? classifyClosingIntent({ reply: content }).then(
      (judgment) => ({ kind: "closing" as const, ...judgment }),
    )
  : Promise.resolve(null);
```

Extend the `logisticsJudgment` union type to include this new `kind`, and
pass the resolved `intent` (or `null` on failure/skip) into the `decide()`
call as a new `DecisionInput` field, e.g. `closingIntent: "closing" |
"details" | "other" | null`.

**4.3 — `server/src/decide.ts`**: in the `already_resolved` gate, prefer
`input.closingIntent` when present, falling back to the existing regex
when it's `null` (failed call, or classifier wasn't invoked for some
reason):

```ts
const closing =
  input.closingIntent != null
    ? input.closingIntent === "closing"
    : CLOSING_PATTERN.test(input.patientTurn);
const wantsDetails =
  input.closingIntent != null
    ? input.closingIntent === "details"
    : BOOKING_DETAIL_PATTERN.test(input.patientTurn);
```

Keep `CLOSING_PATTERN`/`BOOKING_DETAIL_PATTERN` in the file — do not
delete them, same discipline as every other regex-fallback pair in this
codebase.

**Important: this does not violate the purity constraint from §2.**
`decide()` still makes zero calls itself — `closingIntent` arrives as a
plain, already-resolved value on `DecisionInput`, exactly like
`schedulingPreference`/`escortContact`/`shippingAddress` do today.

## 5. Acceptance criteria / test cases

Add a new `harness_inputs/*.json` scenario (or extend an existing one that
reaches an already-resolved state) covering:

- Exact existing regex matches still work when the classifier call fails
  (simulate by asserting fallback behavior, or by testing `decide()`
  directly with `closingIntent: null` and a matching/non-matching
  `patientTurn`).
- Phrasing the current regex misses but should now be caught:
  - Closing: `"I think that covers it"`, `"nope, all set for now"`,
    `"cool, appreciate it"`.
  - Details: `"remind me where I'm headed again?"`, `"who's it with?"`,
    `"what am I supposed to do again before it?"`.
- A reply that is neither (`"other"`) continues to fall through
  `already_resolved`'s existing generic branch unchanged.
- Confirm no latency/cost regression on turns where `session.resolution`
  is `null` — the new call must not fire at all on an ordinary
  history-taking or pre-booking turn (same as the existing two
  classifiers).

Per `docs/interview-prep.md` Module 10, this should ship as a permanent
regression scenario, not a one-off manual test.

## 6. Tradeoffs / things to watch

- This adds one more conditional LLM call to the turn-latency budget
  (Module 8) — but only on turns where `session.resolution != null`,
  which is already a fairly rare/terminal conversational state, so the
  cost is narrowly scoped.
- Three-way classification (`closing`/`details`/`other`) is a slightly
  different shape than the existing binary `classifyDecline` — worth
  double-checking the schema enum is enforced the same way `logistics-
  llm.ts`'s other schemas are (`additionalProperties: false`, required
  fields).
- Don't be tempted to fold this into `classifyDecline` or extend
  `extractTurn`'s existing signals (`requestType`, etc.) instead — this is
  a distinct judgment about an *already-resolved* session's follow-up
  turn, not a clinical fact or a general conversational signal, and mixing
  it into `ConversationSignals` would blur a boundary that's currently
  clean (signals describe *tone*, not *what to do about an existing
  booking*).

## Files referenced

- `server/src/decide.ts` — `already_resolved` gate, `CLOSING_PATTERN`,
  `BOOKING_DETAIL_PATTERN`, `DecisionInput`.
- `server/src/logistics-llm.ts` — `classifySoonestPreference`,
  `classifyDecline`; where the new `classifyClosingIntent` should live,
  following the same shape.
- `server/src/sessions.ts` — the `logisticsCall` ternary and
  `Promise.all([extractTurn(...), logisticsCall.catch(...)])` block; where
  the new conditional branch and its `.catch()` fallback should be added.
- `harness_inputs/*.json`, `scripts/replay_session.mjs` — existing eval
  harness patterns to model the new regression scenario on.
- `docs/interview-prep.md` — Module 1 (why `decide()` must stay pure),
  Module 8 (latency/concurrency budget), Module 9 (regex vs. LLM judgment
  rule — this ticket is a direct application of that rule to a gap it
  currently doesn't cover), Module 10 (eval harness).
