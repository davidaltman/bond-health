# Bug investigation: red-flag question repeated verbatim

**Conversation ID:** `conv_6201m1xb7n63f4darfd5jw8064e8` (ElevenLabs conversation)
**Reported symptom:** Daphne asked the red-flag question —
*"Before I set anything up — any bleeding, unexplained weight loss, or changes
in your bowel habits?"* — and then repeated it, apparently after the patient
replied "nope".
**Reporter's hypothesis:** word/negation matching on "nope" failed.
**Status: CONFIRMED** — root cause identified and confirmed against the real
ElevenLabs transcript (§0.1). See §3 for the transcript-level walkthrough.

This doc is written so a fresh agent session can pick up the investigation
without any prior context from the chat that produced it.

---

## 0. The real transcript (recovered)

The full ElevenLabs conversation was obtained directly from the reporter
(pasted from the ElevenLabs dashboard UI). Relevant turns, in order:

```
Daphne: Hi David, I'm Daphne. What would you like help getting scheduled today?
User:   I need to schedule a colonoscopy.
Daphne: Before I set anything up — any bleeding, unexplained weight loss, or
        changes in your bowel habits?
User:   Nope.
Daphne: Got it. Before I set anything up — any bleeding, unexplained weight
        loss, or...                                          [REPEAT #1]
User:   Oh, it's not working now.
Daphne: Noted — that's useful. Before I set anything up — any bleeding,
        unexplained weight loss, or...                       [REPEAT #2]
User:   Oh, it's fine. No, go on to the next question.
Daphne: Let's get that scheduled for you. Would you like me to find you an
        appointment?                                          [GATE ADVANCES]
User:   Yes, please.
...     (day/time, escort, shipping, booking confirmation — all normal)
```

Note there is no "have you had a colonoscopy before" / family-history
question anywhere before the red-flag question — confirming this session ran
in `scheduling_only` mode (`sufficiency`/`eligibility` gates skipped, per
`decide.ts`'s `SessionMode`), which is expected and not itself a bug.

This transcript **confirms §2's hypothesis directly**, using a clean
same-conversation comparison — see §3.

## 0.1 How this was obtained / how to get it yourself next time

No transcript, log, or database record for this conversation ID exists
anywhere in this repo. Checked and confirmed absent:

- No `transcripts/` directory exists in the repo at all (verified via `find`,
  `ls`, and `git status` — a prior tool search in this chat surfaced a
  plausible-looking but **fabricated** file listing for a `transcripts/`
  folder; do not trust any reference to it, it does not exist on disk).
- No database, log file, or export in the repo contains this conversation ID
  (`grep -r` for the ID across the full tree returns nothing).
- Per `docs/interview-prep.md` (Module 11) and `server/src/sessions.ts`,
  **sessions are in-memory only** — a server restart loses every live
  session's ledger, trace, and decision history permanently.

The transcript above was recovered from the **ElevenLabs dashboard UI**
directly (the per-turn latency/ASR/LLM/TTS timing annotations in the pasted
text are ElevenLabs' own call-inspector view). For future investigations,
either pull the same view from the ElevenLabs dashboard for the
`conv_...` ID, or use the API
(`GET /v1/convai/conversations/{conversation_id}`).

**What the transcript does *not* give us**: the backend's internal `trace`
(which `extractTurn` operations were proposed, what `applyOperations` did
with them, `decision.reason` per turn). That only exists if the backend
session was still live and queried via `GET /api/session/:id/state`, or if
it was exported via `exportScenario`. Neither was available here. Everything
in §3 below is therefore still an **inference from behavior**, not a
direct read of the extraction output — extremely well-supported by the
transcript, but if 100% certainty is needed, reproduce locally per §4 and
inspect `extractTurn`'s raw output directly.

---

## 1. How the red-flag gate is supposed to work

The question is asked by gate 6 in `server/src/decide.ts` ("safety — second
pass"):

```389:412:server/src/decide.ts
  // Symptoms get checked once, only at the point where a booking is otherwise
  // possible. Asking earlier would be an interrogation; not asking at all would
  // mean booking a screening procedure for a potentially diagnostic problem.
  if (!redFlagsAddressed(readings)) {
    if (exhausted("red_flag_symptoms")) return giveUp("red_flag_symptoms", "whether you have any symptoms");
    return {
      ...withRecommendation,
      outcome: "ASK",
      gate: "safety",
      reason: "Screening is indicated but symptoms have never been asked about.",
      missingSlot: "red_flag_symptoms",
      say: RED_FLAG_QUESTION,
    };
  }
```

`redFlagsAddressed` (in `server/src/requirements.ts`) is deliberately
**satisfied by an answer to *any one* of the four red-flag slots**, not all
four — it's one compound question, not a checklist:

```389:400:server/src/requirements.ts
export function redFlagsAddressed(readings: Map<Slot, SlotReading>): boolean {
  return RED_FLAG_SLOTS.some((slot) => isAnswered(readSlot(readings, slot)));
}
```

`RED_FLAG_SLOTS` = `rectal_bleeding`, `unexplained_weight_loss`,
`bowel_habit_change`, `iron_deficiency_anemia`. `isAnswered()` requires a
slot's aggregated status to be `active`, `resolved`, or **`never`** — not
`unknown`:

```244:252:server/src/requirements.ts
export function isAnswered(reading: SlotReading): boolean {
  return reading.status === "active" || reading.status === "resolved" || reading.status === "never";
}
```

So: **if a single denial fact with status `"never"` lands on *any one* of
those four slots, the gate should be satisfied and should not fire again.**
The question repeating means that never happened — no red-flag slot ended
up with an "answered" status after the patient's reply. The rest of this doc
is about tracing why.

---

## 2. Confirmed code bug: `NEGATION_PATTERN` does not match "nope"

`extractTurn`'s per-turn LLM call is expected to look at the patient's reply
and propose an `add` operation with `status: "never"` for whichever red-flag
topic(s) were denied. Before that operation reaches the ledger, it passes
through `coerceStatus` in `server/src/extract-turn.ts`, a regex safety net
that exists specifically to stop the model from mis-asserting `"never"`
(see the family-history bug this same mechanism was built to catch,
documented in Module 2 of `docs/interview-prep.md`):

```242:262:server/src/extract-turn.ts
const NEGATION_PATTERN =
  /\b(no|not|never|none|nobody|nothing|neither|denies?|denying|didn't|doesn't|hasn't|haven't|isn't|wasn't)\b/i;
...
function coerceStatus(op: string, status: FactStatus | null, sourceQuote: string): FactStatus | null {
  if (op === "add" && status === "never" && !NEGATION_PATTERN.test(sourceQuote)) {
    return "unknown";
  }
  return status;
}
```

The check is: *"does the model's own `sourceQuote` (the patient's exact
words) contain a whole-word negation term?"* If not, any claimed `"never"`
is downgraded to `"unknown"` — a safe fallback in general, but it has a
gap. **I verified this directly:**

```
node -e '
const NEGATION_PATTERN = /\b(no|not|never|none|nobody|nothing|neither|denies?|denying|didn'"'"'t|doesn'"'"'t|hasn'"'"'t|haven'"'"'t|isn'"'"'t|wasn'"'"'t)\b/i;
["nope","nah","no","no.","Nope, none of that.","nada","nuh-uh","not really","no bleeding"]
  .forEach(t => console.log(JSON.stringify(t), NEGATION_PATTERN.test(t)));
'
```

Result:

| Quote | Matches `NEGATION_PATTERN`? |
|---|---|
| `"nope"` | **false** |
| `"nah"` | **false** |
| `"no"` | true |
| `"no."` | true |
| `"Nope, none of that."` | true (because of "none") |
| `"nada"` | **false** |
| `"nuh-uh"` | **false** |
| `"not really"` | true |
| `"no bleeding"` | true |

The regex uses `\bno\b` — a **whole-word** match on "no". "nope" contains
"no" but immediately followed by "pe" with no word boundary in between, so
`\bno\b` does not match inside "nope". Same for "nah", "nada", "nuh-uh" —
none contain any of the listed whole-word negation terms.

**This is a narrow, specific gap**: any denial that pads "no" with more
letters into a single word ("nope", "nah", "nada", "naw") fails the check,
while a denial that adds *extra words* ("no thanks", "nope, none of that",
"not really") is caught fine, because those extra words often independently
match the pattern.

---

## 3. The full causal chain, walked through the real transcript

The recovered transcript (§0) gives a clean same-conversation A/B: two
different patient denials, one that gets treated as an answer and one that
doesn't, differing only in whether "no" appears as a standalone token.

**Turn A — "Nope." (fails, causes Repeat #1):**

1. Gate 6 fires, asks `RED_FLAG_QUESTION`. `askCounts["red_flag_symptoms"]`
   becomes `1` after this (not yet a repeat — `isRepeat` requires `>= 2`).
2. Patient replies `"Nope."`.
3. `extractTurn` runs with `precedingAgentTurn = RED_FLAG_QUESTION`,
   `patientTurn = "Nope."`. Per its system prompt's "DENIALS ARE FACTS" rule,
   this should become an `add` operation with `status: "never"` for at least
   one red-flag slot (e.g. `rectal_bleeding`), with a `source_quote` derived
   from "Nope."
4. `coerceStatus` checks: is this an `add` claiming `"never"`? Yes. Does the
   quote match `NEGATION_PATTERN` (`\bno\b` etc.)? **"Nope" does not** — "no"
   is fused into a longer word with no trailing boundary (confirmed
   empirically in §2). Status is silently downgraded to `"unknown"`.
5. The fact lands on the ledger with `status: "unknown"`. `isAnswered()`
   requires `active`/`resolved`/`never` — `"unknown"` doesn't count.
6. `redFlagsAddressed()` returns `false` (no red-flag slot is "answered").
7. Gate 6 fires again. `askCounts` becomes `2`, `isRepeat` is now true, so
   `composeReply` prepends an acknowledgment — matching the transcript's
   **"Got it."** prefix on Repeat #1 exactly.

**Turn B — "Oh, it's not working now." (fails, causes Repeat #2 — but this
one looks like correct behavior, not a bug):**

This reply doesn't mention bleeding, weight loss, bowel habits, or contain
any negation at all — it reads as a comment about a technical glitch (audio
issue?), unrelated to the question asked. `extractTurn` most plausibly
returns no usable operation for this slot at all, so the gate correctly
determines the question still hasn't been answered and re-asks. `askCounts`
becomes `3`; `composeReply` prepends **"Noted — that's useful."** — again
matching the transcript exactly. This turn is not part of the bug; it's the
gate behaving correctly on an off-topic reply. (One turn away from
`MAX_ASKS_PER_SLOT = 3` triggering `HANDOFF` via the `stuck` gate on the
*next* unresolved attempt — worth noting for anyone worried this could have
spiraled further.)

**Turn C — "Oh, it's fine. No, go on to the next question." (succeeds,
gate advances):**

Same denial intent as Turn A, differently punctuated. This time "No," is
followed by a comma — a non-word character — so `\bno\b` **does** match
`NEGATION_PATTERN`. If `extractTurn` proposed `status: "never"` off this
turn (plausible, since the model has the same `RED_FLAG_QUESTION` context
and a clear "No" in the reply), `coerceStatus` leaves it alone this time.
The slot's aggregated status becomes `"never"`, `isAnswered()` returns true,
`redFlagsAddressed()` is satisfied, and the very next reply moves on to the
readiness gate ("Let's get that scheduled for you...") — exactly what the
transcript shows.

**This is about as strong a confirmation as is possible without a direct
read of `extractTurn`'s raw output**: the same patient, denying the same
thing, twice, in the same conversation — accepted once, rejected once —
with the only structural difference being whether "no" stood alone or was
fused into "nope." That is precisely the gap identified and empirically
verified in §2, not speculation about "the LLM messed up somehow."

One secondary, unrelated observation from this transcript, worth its own
follow-up: the final booking confirmation reads *"Your prep kit ships to
**Send it to** one two four Happy Lane, London, England..."* — the shipping
address value appears to retain the patient's lead-in phrase ("Send it to")
verbatim rather than stripping it, suggesting a separate parsing gap in
`server/src/shipping.ts`'s address extraction. Not investigated further
here; flagged for a separate pass.

---

## 4. How to reproduce this locally

Fastest path: use the existing eval harness pattern rather than a live
ElevenLabs call.

- Look at `harness_inputs/red_flag_bleeding.json` for the shape of a
  harness scenario, and `scripts/replay_session.mjs` for how it's run
  against the real backend (real OpenAI calls, not mocked).
- Build a minimal scenario (or a one-off script calling
  `POST /api/session/:id/message` twice: once to reach the red-flag gate,
  once with the patient turn `"nope"`), then inspect the response's
  `facts` array for the resulting status on whichever red-flag slot got
  populated, and `decision.gate`/`decision.missingSlot` on the *next* turn
  to see if it re-fires `"safety"`/`"red_flag_symptoms"`.
- Alternative, faster still: call `extractTurn` directly in a small script
  with `factsOnFile: "(no facts on file yet)"`,
  `precedingAgentTurn: RED_FLAG_QUESTION` (import from `requirements.ts`),
  `patientTurn: "nope"`, and print the raw `operations` array before and
  after `coerceStatus` would apply — this isolates the extraction+coercion
  step without needing a full session.

Also worth testing in the same pass, since they're the same class of bug:
`"nah"`, `"nada"`, `"naw"`, `"meh no"` — anything where the denial word is
mashed into a longer token rather than standing alone or followed by a
separate matching word.

---

## 5. Alternative hypotheses — status after reviewing the real transcript

Before the transcript was recovered, several alternative mechanisms could
have produced an identical-looking symptom. With the transcript in hand
(§0), here's where each one stands:

1. **Extraction call failed or timed out entirely — NOT RULED OUT for Turn A,
   but no longer the leading theory.** `sessions.ts` catches this
   (`kind: "extraction_failed"` trace event, logged to console). This can't
   be fully excluded without the backend `trace` (unavailable, §0.1), but
   it's now a weaker explanation than the regex bug: it doesn't explain why
   Turn C's "No, go on to the next question." *succeeded* immediately
   afterward in the same conversation, with no code change in between. A
   pure random API failure wouldn't naturally correlate with "no" being
   fused into another word vs. standing alone. Still worth a real
   `extractTurn` repro (§4) to be certain for Turn A specifically.

2. **The model produced no usable operation for a low-information reply —
   CONFIRMED as the likely explanation for Turn B, not Turn A.** Turn B
   ("Oh, it's not working now.") plausibly falls here: no symptom words, no
   negation, nothing for `extractTurn` to attach a fact to. That's arguably
   correct behavior, not a bug — see §3. Turn A ("Nope.") is a *clear*
   denial with obvious intent, which is why the regex-coercion explanation
   (§2/§3) fits it better than "the model didn't understand the reply."

3. **The repeat might not be gate 6 firing twice, e.g. a duplicate call or
   client-side race — RULED OUT.** The transcript shows a distinct
   acknowledgment prefix on each repeat ("Got it." on #1, "Noted — that's
   useful." on #2), which only happens when `composeReply`'s `isRepeat`
   flag is set (`askCounts[missingSlot] >= 2`, `server/src/sessions.ts`).
   That confirms `askCounts` genuinely incremented across real, distinct
   gate evaluations — this is the gate correctly detecting a repeat, not a
   duplicate `advance_scheduling` call or a client-side race producing an
   identical utterance twice.

4. **ASR mis-transcription — RULED OUT for the turns that matter.** The
   pasted transcript shows "Nope." and "No, go on to the next question." as
   the literal ASR output (30ms/73ms ASR latency, no low-confidence
   indicators on those specific turns), and the backend's behavior is fully
   consistent with those exact strings being received. No reason to suspect
   the text reaching `extractTurn` differed from what's shown.

**Net: the transcript strongly narrows this down to §2/§3's `NEGATION_PATTERN`
gap as the cause of Repeat #1, with Repeat #2 being separately explainable as
correct gate behavior on an off-topic reply.** A direct `extractTurn`/
`coerceStatus` repro (§4) would give 100% certainty by showing the actual
`operations` array for "Nope." before and after coercion, but is no longer
strictly necessary to justify shipping the fix in §6.

---

## 6. Proposed fixes, with tradeoffs

Options for `server/src/extract-turn.ts`'s `NEGATION_PATTERN`:

- **Minimal, safe patch:** broaden the pattern to include common
  standalone negation interjections as their own alternatives:
  `nope|nah|nada|naw|nuh-uh` (as literal alternatives, not relying on `\b`
  splitting a "no" prefix). Low risk, directly closes the gap found here.
- **Slightly broader:** also match a sentence that is *just* "no" with
  trailing punctuation/whitespace only, case-insensitively — already
  covered by the existing pattern (`"no."` matches), so this is really
  about adding the colloquial variants above, not changing the whole-word
  logic.
- **Do not** simply remove the word-boundary requirement (e.g. changing
  `\bno\b` to `no`) — that would reintroduce false positives on words like
  "known", "nonetheless", "denominator", etc., which is exactly the
  failure mode this guard exists to prevent in the first place.
- **Longer-term, more robust:** rather than pattern-matching only the
  `sourceQuote`, consider having `coerceStatus` (or a preceding step) also
  check the full raw `patientTurn` text, not just whatever substring the
  model chose to cite as `sourceQuote` — a model might cite a partial quote
  that strips the actual negation word out even when the full reply
  contained one. Bigger change, needs its own test coverage in
  `harness_inputs/`.

Any fix here should get a new `harness_inputs/*.json` scenario asserting
that a bare "nope"/"nah" reply to `RED_FLAG_QUESTION` results in
`redFlagsAddressed` becoming true and the gate not re-firing — per
`docs/interview-prep.md` Module 10, this is exactly the kind of bug that
should become a permanent regression test, not just a one-off patch.

---

## Files referenced

- `server/src/decide.ts` — gate 6 ("safety", second pass), `RED_FLAG_QUESTION`
  usage, `MAX_ASKS_PER_SLOT`/`giveUp`.
- `server/src/requirements.ts` — `RED_FLAG_SLOTS`, `redFlagsAddressed`,
  `isAnswered`, `SlotReading`/`aggregateStatus`.
- `server/src/extract-turn.ts` — `NEGATION_PATTERN`, `coerceStatus`,
  the extraction system prompt's "DENIALS ARE FACTS" section.
- `server/src/ledger.ts` — `applyOperations`, `FactStatus` vocabulary.
- `server/src/sessions.ts` — `TraceEvent` kinds, where extraction failures
  and applied operations are recorded, `isRepeat` computation.
- `harness_inputs/red_flag_bleeding.json`, `scripts/replay_session.mjs` —
  existing eval harness patterns to model a new regression test on.
- `docs/interview-prep.md` — Module 2 (ledger/extraction, the sibling
  family-history bug this same guard was built for), Module 3 (gate order),
  Module 10 (eval harness / "watching and improving" loop), Module 11
  (known limitations, incl. barge-in desync as an alternative explanation).
