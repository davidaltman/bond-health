# Bug investigation: opening request logged as a bogus clinical fact

**Source:** same live call as `docs/bug-investigation-conv_8201m22mqqnafgza85n87yx7csbg.md`
(`conv_8201m22mqqnafgza85n87yx7csbg`), a different symptom noticed afterward while
reviewing that session's ledger in the frontend: a fact card reading
`colonoscopy scheduling` / `condition` / `unsure` ("unsure" is the UI label for
ledger status `unknown` -- see `LiveFactsPanel.tsx`'s `STATUS_LABEL`). Unrelated
mechanism from the echo-desync bug -- split into its own doc per that
investigation's own precedent (see its "what this doesn't fix" section and
`docs/bug-investigation-shipping-address-leading-phrase.md`'s opening note).

**Status: MITIGATED, not provably fixed** — this is a probabilistic model
slip, not a deterministic code path, so there is nothing to assert a hard
regression test against. The prompt was tightened with an on-point example;
46/46 repeated live calls against the exact reported phrase (21 before the
change, 25 after) came back clean either way, which only confirms the miss
rate is low, not that the fix changed it. See §3.

---

## 0. The observed symptom

The patient's very first utterance in that call, before Daphne had asked
anything (`system__conversation_history` in the ElevenLabs dynamic
variables, same transcript pulled for the sibling investigation):

```
User: "Uh, I need to schedule a colonoscopy."
```

Reviewing that session's ledger afterward in the frontend shows a fact card:
subject `self`, category `condition`, attribute something like
`colonoscopy scheduling`, status `unknown` ("unsure" in the UI). This is a
line item that should not exist at all -- "I need to schedule a colonoscopy"
is a request, not a statement about the patient's medical history, and
`extract-turn.ts`'s own prompt already says so.

---

## 1. Root cause: a request that names the procedure it wants

`extract-turn.ts`'s system prompt already had this rule before this
investigation:

```121:123:server/src/extract-turn.ts
A request is not a fact. "Can you book it for me" tells us what the patient
wants, which is carried by request_type below, and must not become a clinical
fact about a procedure they have had.
```

The one worked example, *"Can you book it for me,"* never names the
procedure -- "it" is a pronoun standing in for context the model has to
track separately. *"I need to schedule **a colonoscopy**"* is the harder
case: it both requests an action *and* names a clinical noun in the same
sentence, with no preceding question to frame it (`extractTurn`'s
`precedingAgentTurn` is literally `null`/"(nothing -- the patient spoke
first)" for the opening turn). The instruction that should cover this case
does, logically, but without a directly-matching example the model
sometimes generalizes the wrong way and reaches for the closed-vocabulary
"colonoscopy" attribute out of `requirements.ts`'s slot list instead of
recognizing the whole sentence as a pure request.

This is the same failure family already caught independently, minutes
before this investigation, in the `shipping_echo_desync` harness run
(unrelated scenario, same root cause): patient reply *"Sure, please,"*
answering *"Would you like me to find you an appointment?,"* produced a
bogus `add`: subject `self`, category `condition`, attribute
`"appointment scheduling"`, status `active`. Same instruction
("a request is not a fact"), same kind of miss, different trigger sentence.

**Confirmed non-deterministic, not a deterministic bug**: the exact opening
line, replayed 21 times against a fresh session before any prompt change,
came back with an empty `operations` list every single time
(`curl .../api/session/:id/message` with `{"content": "Uh, I need to
schedule a colonoscopy."}}`, checked via the response's `applied` array).
There is no code path that reliably reproduces this -- it is
`reasoningEffort: "low"` (the deliberate low-cost/low-latency model setting
used for this call, per the module's own header comment) occasionally not
following an instruction that is already present and already correct.

---

## 2. Why this is mostly cosmetic, not a gating bug

`requirements.ts`'s `colonoscopy_screening` slot matches any fact whose
attribute/value contains `colonoscop` (`/colonoscop|colon scope|sigmoidoscop/i`),
so this bogus fact *would* attach to that slot if the session were in `full`
mode. But its status is `unknown`, and `isAnswered()` only counts `active`,
`resolved`, or `never` (`requirements.ts`) -- so it does not silently
satisfy the "have you had a colonoscopy before" gate the way a real, wrongly
transcribed fact could. In `scheduling_only` mode (used for the voice
scheduling agent this call went through), the eligibility/sufficiency gate
never runs at all, so this fact had zero effect on what Daphne asked or
decided. The only real cost observed is a nonsensical, confusing card in the
"What Daphne knows" review panel -- worth fixing for review-panel honesty,
not because it changed the call's outcome.

---

## 3. The mitigation

Added a directly-matching example to the existing instruction in
`server/src/extract-turn.ts`, rather than adding new schema, a new
deterministic filter, or a new classifier -- the instruction was already
correct, it just needed a harder example to generalize from:

```121:128:server/src/extract-turn.ts
A request is not a fact. "Can you book it for me" tells us what the patient
wants, which is carried by request_type below, and must not become a clinical
fact about a procedure they have had. This still applies when the request
names the procedure itself, including as the very first thing the patient
says with no question yet to answer: "I need to schedule a colonoscopy" and
"I want to book a colonoscopy" are requests, not evidence the patient has
ever had one -- return no operation for the procedure named this way. A
colonoscopy only belongs on the ledger once the patient actually answers
whether they have had one, e.g. "I had one eight years ago" or "No, never."
```

**Why no regression test was added for this one, unlike the echo-desync
fix:** there is no deterministic trigger to assert against. A hard test that
asserts "this exact phrase never produces an operation" would be pinning
today's random draw from a nondeterministic model, not the actual property
that matters (a low, ideally decreasing, miss rate). The honest verification
available is what was run here: the full eval suite (13/13 scenarios, all
existing checks) to confirm the added sentence changed nothing else, plus
volume-running the exact reported phrase — 21 times before the prompt
change, 25 after — both batches coming back clean. That is evidence the miss
rate is low both before and after, not proof the change helped; a true
before/after comparison would need enough runs to estimate a base rate on
the order of 1-in-20 or rarer, which is impractical to pin down here.

If this recurs, the next escalation (not done here, since the current
instruction is already correct and just needed reinforcement) would be a
deterministic backstop in `sessions.ts`, parallel to `coerceStatus` in
`extract-turn.ts`: reject any `add` operation whose `source_quote` also
matches a "please/can you/I need/I want to [schedule/book]" pattern, the
same way `coerceStatus` already downgrades an unsupported "never" rather
than trusting the model outright.

---

## Files referenced

- `server/src/extract-turn.ts` — the "a request is not a fact" instruction;
  where the new example was added.
- `server/src/requirements.ts` — `colonoscopy_screening`'s slot matcher and
  `isAnswered`; why this particular miss doesn't affect gating.
- `frontend/src/components/LiveFactsPanel.tsx` — `STATUS_LABEL`'s
  `unknown: "unsure"` mapping, which is why the UI showed "unsure" rather
  than "unknown".
- `harness_inputs/shipping_echo_desync.json` — where the sibling
  `"appointment scheduling"` miss was independently caught, same call
  session, unrelated to this doc's fix.
- `docs/bug-investigation-conv_8201m22mqqnafgza85n87yx7csbg.md` — the
  sibling investigation from the same source call.
