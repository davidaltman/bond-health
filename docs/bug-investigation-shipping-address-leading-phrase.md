# Bug investigation: shipping address retains patient's command phrase

**Source:** noticed in the same transcript as
`docs/bug-investigation-conv_6201m1xb7n63f4darfd5jw8064e8.md`
(`conv_6201m1xb7n63f4darfd5jw8064e8`), while investigating the red-flag
repeat bug. Unrelated symptom, unrelated code path — split into its own
doc per that investigation's closing note.

**Status: CONFIRMED — fully deterministic, no LLM involved, reproducible
by inspection alone.** Unlike the red-flag bug, this one needs no inference
about what a model call might have done; every step is plain string code.

---

## 0. The observed symptom

From the transcript, the shipping ask and the patient's reply:

```
Daphne: Last thing — where should I ship your prep kit so it arrives about
        a week before your appointment? If you'd rather pick one up
        yourself at a pharmacy, that's fine too.
User:   Send it to 124 Happy Lane, London, England.
```

And the final booking confirmation:

```
Daphne: ...Your prep kit ships to Send it to one two four Happy Lane,
        London, England, arriving by Monday, September twenty-one —
        about a week before your appointment.
```

("one two four" etc. is just the TTS engine reading "124" digit-by-digit —
not part of the bug.) The bug: the spoken address is *"Send it to 124 Happy
Lane, London, England"* — the patient's entire sentence, including their
own lead-in command phrase, not just the address itself.

---

## 1. The exact code path (fully deterministic — traced end to end)

**Step 1 — parsing.** `parseShippingAddress` in `server/src/shipping.ts`
does no stripping of leading phrases at all:

```39:44:server/src/shipping.ts
export function parseShippingAddress(raw: string, declineJudgment: boolean | null = null): ShippingAddress {
  const trimmed = raw.trim();
  if (!trimmed) return { provided: false, raw: trimmed };
  const declined = declineJudgment ?? DECLINE_PATTERN.test(trimmed);
  if (declined) return { provided: false, raw: trimmed };
  return { provided: true, raw: trimmed };
}
```

For input `"Send it to 124 Happy Lane, London, England."`:
`DECLINE_PATTERN` (`no thanks|none|already have|pharmacy|skip|...`) does
not match, so this returns `{ provided: true, raw: "Send it to 124 Happy
Lane, London, England." }` — the **entire sentence**, verbatim, becomes
`raw`. This module never had a "strip the command phrase, keep the address"
step to begin with.

**Step 2 — display formatting.** `scheduleDrinkPrepShipment` in
`server/src/scheduler.ts` takes that `raw` and does exactly one piece of
cleanup — stripping *trailing* punctuation/whitespace, not anything at the
front:

```208:220:server/src/scheduler.ts
export function scheduleDrinkPrepShipment(address: ShippingAddress | null, appointmentStartsAt: string): PrepKitShipment {
  if (!address?.provided) return { ordered: false, address: null, arrivesAt: null, trackingId: null };
  const arrivesAt = new Date(new Date(appointmentStartsAt).getTime() - PREP_KIT_LEAD_DAYS * 24 * 60 * 60 * 1000);
  return {
    ordered: true,
    // Trailing sentence punctuation from the patient's own reply ("123 Main
    // St, Apt 2.") reads fine on its own but doubles up once this gets
    // stitched into "ships to {address}, arriving by..." -- stripped here,
    // display-only, same reasoning as escort.ts's label vs raw. The
    // ShippingAddress the parser returned stays untouched as the real record.
    address: address.raw.replace(/[.\s]+$/, ""),
    arrivesAt: arrivesAt.toISOString(),
  };
}
```

`"Send it to 124 Happy Lane, London, England."` →
`.replace(/[.\s]+$/, "")` → `"Send it to 124 Happy Lane, London, England"`
(only the trailing period is removed; the leading "Send it to" survives
completely untouched).

**Step 3 — spoken confirmation.** `buildPrepInstructions` stitches that
value directly into the sentence template:

```227:230:server/src/scheduler.ts
function buildPrepInstructions(shipment: PrepKitShipment): string[] {
  const prepKitLine = shipment.ordered
    ? `Your prep kit ships to ${shipment.address}, arriving by ${formatArrival(shipment.arrivesAt!)} — about a week before your appointment.`
    : "No shipping address on file, so plan to pick up your prep kit at a pharmacy before your appointment.";
```

Result: `"Your prep kit ships to Send it to 124 Happy Lane, London,
England, arriving by Monday, September 21..."` — exactly what's in the
transcript. **This is a fully deterministic string-manipulation bug.**
Given the same patient reply, this reproduces every single time — no model
call, no randomness, nothing to distinguish or rule out. Confirmable by
running `parseShippingAddress` + `scheduleDrinkPrepShipment` directly with
this input string, no session or API call needed.

---

## 2. Why this doesn't happen for the escort/pickup contact (a sibling
   module that already solved a version of this)

`server/src/escort.ts` — the parser for the *other* logistics ask right
before this one in the same gate sequence (`decide.ts`'s `escort` gate,
asked immediately before `shipping`) — already had this exact class of bug
and was fixed for it. Its own comment documents the incident:

```53:61:server/src/escort.ts
/**
 * Backchannel words ("Yeah,", "Um,", "Sure,") that precede the actual
 * answer. Without stripping these first, the clause-boundary search below
 * treats the comma after "Yeah," as the end of the label, and everything
 * that was actually said -- a name, a relationship, an email -- never gets
 * read. Real transcript that found this: "Yeah, you can send an email to
 * myfriend@gmail.com" used to derive the label "Yeah".
 */
const LEADING_FILLER_PATTERN = /^(?:(?:yeah|yep|yes|sure|okay|ok|well|um+|uh+|so|alright|hmm+)[\s,]*)+/i;
```

`escort.ts` strips that filler *before* deriving its short display
`label`, while still keeping the full sentence in `raw` for the audit
record — see `deriveLabel()`. **`shipping.ts` has no equivalent function at
all** — no `deriveLabel`-style short-display value, no leading-phrase
strip, nothing. It only carries `raw`, and `scheduler.ts` speaks `raw`
(minus trailing punctuation) directly.

**Important nuance:** even if `shipping.ts` reused escort's exact
`LEADING_FILLER_PATTERN`, it **would not have caught this specific case**.
That pattern only strips conversational backchannel words
(yeah/yep/sure/okay/well/um/uh/so/alright/hmm) — not command phrases like
*"send it to"*, *"ship it to"*, *"mail it to"*, *"you can send it to"*,
which is what actually appears here. This needs a shipping-specific
pattern, not a copy-paste of the escort one.

---

## 3. Confirmed via direct reproduction

This can be verified without touching the server or a real session at all
— it's pure function composition:

```
node -e '
// paste parseShippingAddress + scheduleDrinkPrepShipment logic, or run via
// ts-node against the real modules, e.g.:
//   import { parseShippingAddress } from "./server/src/shipping.ts";
//   import { scheduleDrinkPrepShipment } from "./server/src/scheduler.ts";
const raw = "Send it to 124 Happy Lane, London, England.";
const stripped = raw.replace(/[.\s]+$/, "");
console.log(stripped);
// -> "Send it to 124 Happy Lane, London, England"
'
```

Recommended real repro for the fresh agent picking this up: import the
actual `parseShippingAddress` and `scheduleDrinkPrepShipment` functions
(via `ts-node` or a quick script under `server/`) and assert on the
resulting `shipment.address` / `buildPrepInstructions` output for a few
realistic patient phrasings — see §5 for suggested test strings.

---

## 4. Proposed fix, with tradeoffs

**Minimal, targeted fix:** add a leading-phrase strip to `shipping.ts`,
mirroring `escort.ts`'s pattern but with shipping-appropriate phrases
instead of backchannel words:

```ts
// Command/lead-in phrases that precede the actual address ("Send it to
// 124 Main St" -> "124 Main St"). Distinct from escort.ts's
// LEADING_FILLER_PATTERN, which only strips conversational backchannel
// words (yeah/um/sure) -- this strips imperative shipping phrases instead.
const LEADING_COMMAND_PATTERN =
  /^(?:(?:yeah|yep|yes|sure|okay|ok|well|um+|uh+|so|alright|hmm+)[\s,]*)*(?:(?:you can |please )?(?:send|ship|mail) (?:it |the (?:kit|prep kit) )?to\s+|address is\s+|it'?s\s+)?/i;
```

Then use the stripped value for **display** (the string spoken back and
stored on `PrepKitShipment.address`), while keeping `ShippingAddress.raw`
as the untouched original — exactly the `raw` vs. display-value split
`escort.ts` already established with `raw` vs. `label`. Concretely: add a
`deriveShippingLine(raw: string): string` helper in `shipping.ts` (parallel
to `escort.ts`'s `deriveLabel`), and have `scheduler.ts`'s
`scheduleDrinkPrepShipment` call it instead of doing its own inline
`.replace(/[.\s]+$/, "")` on the raw parser output directly.

**Tradeoffs / things to watch:**
- A phrase-list regex is inherently incomplete (same class of tradeoff as
  `escort.ts`'s filler list) — it will not catch every possible phrasing a
  patient might use, only the common ones. That's an accepted tradeoff
  elsewhere in this codebase (regex for closed/common vocab, per
  `docs/interview-prep.md` Module 9), not a reason to avoid the fix, but
  worth documenting the same way `escort.ts` and `decide.ts` document their
  known limitations.
- Don't be tempted to route this through an LLM call instead (like
  `classifySoonestPreference`/`classifyDecline` in `logistics-llm.ts`) —
  per Module 9's stated rule, that's reserved for genuinely open-ended
  judgment calls (is this a decline?), not for stripping a fixed, common
  set of lead-in phrases, which is exactly the kind of thing this codebase
  argues should stay in code (see `requirements.ts`'s and `ledger.ts`'s
  headers on the same principle).
- Keep stripping trailing punctuation too (the existing behavior) — don't
  remove that, just add the leading-phrase strip alongside it.

**Regression coverage:** add a scenario (or extend an existing
`harness_inputs/*.json` scenario that reaches the shipping gate) asserting
that a reply like `"Send it to 124 Main St"` produces a spoken confirmation
containing `"ships to 124 Main St"`, not `"ships to Send it to 124 Main
St"`. Per `docs/interview-prep.md` Module 10, this is exactly the kind of
bug that should become a permanent regression test.

---

## 5. Suggested test strings for the fix

Beyond the exact transcript phrase, worth covering in the same pass since
they're the same bug class:

- `"Send it to 124 Happy Lane, London, England."` (the exact transcript case)
- `"Ship it to 42 Wallaby Way"`
- `"You can mail it to 500 Elm Street, Apt 3"`
- `"Please send it to my home address, 10 Downing Street"`
- Plain address with no lead-in at all: `"124 Happy Lane, London, England"`
  (must remain unchanged — don't over-strip and start eating real address
  content)
- A decline, to confirm the fix doesn't interfere with existing behavior:
  `"I'll just grab one at the pharmacy"` → should still produce
  `provided: false`

---

## Files referenced

- `server/src/shipping.ts` — `parseShippingAddress`, `DECLINE_PATTERN`;
  where the fix's leading-phrase strip should live.
- `server/src/scheduler.ts` — `scheduleDrinkPrepShipment`,
  `buildPrepInstructions`; where the raw address currently gets assembled
  into the spoken line.
- `server/src/escort.ts` — sibling module with the precedent fix
  (`LEADING_FILLER_PATTERN`, `deriveLabel`) for the same *class* of bug on
  a different, non-overlapping set of phrases.
- `server/src/decide.ts` — the `shipping` gate (asked right after `escort`,
  same non-blocking shape).
- `docs/bug-investigation-conv_6201m1xb7n63f4darfd5jw8064e8.md` — the
  sibling investigation this was split out from; same source transcript.
- `docs/interview-prep.md` — Module 5 (scheduler mock-booking mechanics,
  the three mocked side effects incl. `scheduleDrinkPrepShipment`), Module 9
  (regex vs. LLM judgment rule), Module 10 (eval harness).
