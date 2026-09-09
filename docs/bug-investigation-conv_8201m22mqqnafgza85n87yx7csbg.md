# Bug investigation: shipping question echoed back as if it were the patient's answer

**Source:** live voice call `conv_8201m22mqqnafgza85n87yx7csbg`, David, scheduling a
colonoscopy. Same sibling category as
`docs/bug-investigation-conv_6201m1xb7n63f4darfd5jw8064e8.md` and the barge-in
desync documented in `docs/app-guide.md` (found in `conv_5801m1wffesjfczr9cwgk3pd90m4`):
a gap between "what gate the backend thinks it asked" and "what the patient
actually heard and answered." This is a new, third variant of that gap, with a
clean fix — implemented below, not just documented.

**Status: FIXED.** Guard added in `server/src/sessions.ts`
(`appendTurn`'s `isEchoOfLastAgentTurn` check); regression scenario added at
`harness_inputs/shipping_echo_desync.json`.

---

## 0. The observed symptom

Requesting the raw transcript from ElevenLabs (`GET
/v1/convai/conversations/conv_8201m22mqqnafgza85n87yx7csbg`) and walking its
`transcript[]` array turn by turn:

```
[17] user   "The email address is victory@gmail.com."
[18] agent  toolCalls=advance_scheduling({"message":"The email address is victory@gmail.com."})
[19] agent  toolResults=advance_scheduling -> "Last thing — where should I ship your prep kit
                so it arrives about a week before your appointment? If you'd rather pick one
                up yourself at a pharmacy, that's fine too."
[20] agent  toolCalls=advance_scheduling({"message":"Last thing — where should I ship your
                prep kit so it arrives about a week before your appointment? If you'd rather
                pick one up yourself at a pharmacy, that's fine too."})
[21] agent  toolResults=advance_scheduling -> "You're booked. ... No shipping address on file,
                so plan to pick up your prep kit at a pharmacy before your appointment."
[22] agent  message="You're booked. ..."
```

Two things stand out, compared to every other question-and-answer pair in this
same call (e.g. `[15]→[16]→[17]` for the escort question, which has the normal
shape: tool result, then a `message` entry that actually speaks it, then a real
user reply):

1. There is **no `{"role": "agent", "message": ...}` entry for the shipping
   question at all.** It came back from the tool at `[19]` but, unlike every
   other question in this call, was never spoken to the patient.
2. `[20]`'s `advance_scheduling` call fired immediately after `[19]`, with
   `message` set to **the exact text of the question the tool had just
   returned** — not a real reply from David. There is no intervening
   `{"role": "user", ...}` transcript entry between `[19]` and `[20]`.

The patient never got a chance to answer. The transcript later confirms he
didn't even know the question had been asked — at `[27]` and `[31]` he's
still trying to offer his address after the call had already "finished":
*"I have an address you can update. Is that all right?"* / *"Can I give you
my address now to update the shipping?"* Hence the user's complaint: the
mailing address got skipped, and it's annoying to have to ask twice for
something never actually heard the first time.

---

## 1. Root cause, in two layers

**Layer 1 — not ours to fix.** Whatever caused ElevenLabs' own agent
orchestration to re-invoke `advance_scheduling` with its own last tool output
as the `message` parameter, instead of speaking that output and waiting for
real user audio, happened entirely inside the ElevenLabs platform. Nothing in
this repo controls that decision — same conclusion as the barge-in desync
doc's *"Tool execution was abandoned due to user input"* case, just a
different trigger shape (there: a real abandoned reply; here: a phantom
re-call using the tool's own prior output as input).

**Layer 2 — ours, and fixable.** `server/src/index.ts`'s
`POST /api/session/:id/message` (what `advance_scheduling` calls) has no way
to know a `message` didn't come from real patient speech, so it dutifully ran
it through `exchange()` → `appendTurn()` → the normal extraction/`decide()`
pipeline. The shipping question's own wording —
*"...pick one up yourself at a pharmacy, that's fine too."* — is exactly the
kind of phrase `shipping.ts`'s `DECLINE_PATTERN` exists to catch
(`no thanks|none|already have|pharmacy|skip|...`). Fed that text as if it were
the patient's reply, the shipping gate reasonably concluded "the patient
declined a shipping address" and moved straight to `ACT`, producing *"No
shipping address on file, so plan to pick up your prep kit at a pharmacy."*
Confirmed by direct reproduction — `parseShippingAddress(shippingQuestionText)`
returns `{ provided: false, ... }` because `DECLINE_PATTERN.test(...)` matches
on `"pharmacy"` in the question's own second sentence. (`classifyDecline` in
`logistics-llm.ts`, the LLM path that runs instead of the regex when it
succeeds, would very plausibly have agreed — read out of context, "if you'd
rather pick one up yourself at a pharmacy, that's fine too" reads like a
patient stating a preference, not like a question.)

This is worse than a barge-in dropping a reply on the floor: there, the
*next* real thing the patient said got misrouted to the wrong parser. Here,
the *question itself* got fed back in as the answer, and its own wording
happened to read as a decline — actively wrong, not just misfiled.

---

## 2. The fix

A patient turn that is a verbatim echo (whitespace/case aside) of Daphne's
own immediately preceding line can never be a genuine reply — a real patient
answering "where should I ship your prep kit" does not repeat the question
back word for word. Added to `appendTurn()` in `server/src/sessions.ts`,
right where the existing "empty patient turn" skip already lives:

```180:213:server/src/sessions.ts
  const lastAgentTurn = [...session.turns].slice(0, -1).reverse().find((candidate) => candidate.role === "agent");
  const isEchoOfLastAgentTurn =
    role === "user" && lastAgentTurn != null && normalizeForEchoCheck(content) === normalizeForEchoCheck(lastAgentTurn.content);

  if (role !== "user" || !content.trim() || isEchoOfLastAgentTurn) {
    session.trace.push({
      turn: turn.index,
      at: new Date().toISOString(),
      kind: "extraction_skipped",
      detail: isEchoOfLastAgentTurn
        ? "patient turn is a verbatim echo of Daphne's own preceding line -- tool/turn-taking desync, not a real reply; decision left unchanged"
        : role === "user"
          ? "empty patient turn"
          : "agent turn, nothing to extract",
    });
    return { /* same shape as the empty-turn early return, decision unchanged */ };
  }
```

`normalizeForEchoCheck` is deliberately just `.trim().toLowerCase().replace(/\s+/g, " ")` —
**exact** match, not fuzzy/substring. A looser check (e.g. "reply contains most
of the question's words") would risk misfiring on a patient who genuinely,
if unusually, quotes Daphne's question back ("you asked where I should ship
it — 42 Elm Street"). The failure mode this guards against reproduces the
agent's own line byte-for-byte, so an exact match is both sufficient and the
most conservative option available.

Effect: the echoed turn short-circuits before extraction or `decide()` ever
run — `askCounts`, the ledger, and `session.resolution` are all left exactly
as they were. `exchange()`'s existing flow then re-runs `composeReply` against
the *same* unchanged decision and re-sends the identical question. The next
*real* reply lands on a session that's still correctly waiting on
`shipping_address`, not one that already (wrongly) marked it declined.

This fix lives in `appendTurn`, so it protects both the voice path
(`/api/session/:id/message` → `exchange()`) and the raw text-mode/inspection
path (`/api/session/:id/turn` → `appendTurn` directly) — and it is generic
across gates, not shipping-specific: the same phantom-echo failure could in
principle recur after any `ASK`, and this guards all of them at the one
shared choke point turns pass through.

---

## 3. Regression coverage

`harness_inputs/shipping_echo_desync.json` (text mode): drives a session to
the shipping gate, then sends a patient turn whose content is the exact
shipping question text, and asserts:

- The echoed turn still resolves `ASK via shipping` (not `ACT`, not a
  decline) — and does so in ~10ms, confirming no model call was made (the
  guard short-circuits before extraction/`decide()`).
- The reply repeats the same shipping question.
- The next, real address turn ("Ship it to 789 Birch Lane, Riverside.")
  produces a booking confirmation containing "789 Birch Lane" and — the
  actual live-call symptom — does **not** contain "No shipping address on
  file."

Run via `npm run eval` in `server/` (globs every file in `harness_inputs/`,
no registration needed) or directly:
`node scripts/replay_session.mjs harness_inputs/shipping_echo_desync.json`.

---

## 4. What this doesn't fix

This guard only catches the *exact-echo* shape of desync. The barge-in
desync documented in `docs/app-guide.md` — a genuinely new, unrelated
utterance landing on a gate that never actually reached the patient's ears —
has no verbatim signature to key off of and remains open, for the reasons
already given there (needs either a plausibility guard per-parser, or a
client-side signal for abandoned tool execution, neither of which exists
yet). This fix and that one are complementary, not overlapping.

---

## Files referenced

- `server/src/sessions.ts` — `appendTurn`'s new echo guard,
  `normalizeForEchoCheck`.
- `server/src/shipping.ts` — `DECLINE_PATTERN`, `parseShippingAddress`; where
  the echoed question's own wording got misread as a decline.
- `server/src/logistics-llm.ts` — `classifyDecline`, the LLM path that would
  likely have agreed with the wrong read.
- `harness_inputs/shipping_echo_desync.json` — regression scenario.
- `docs/bug-investigation-conv_6201m1xb7n63f4darfd5jw8064e8.md`,
  `docs/bug-investigation-shipping-address-leading-phrase.md` — sibling
  investigations from the same class of transcript-driven debugging.
- `docs/app-guide.md` Limitations — the barge-in desync this is a sibling of,
  and remains unfixed by this change.
