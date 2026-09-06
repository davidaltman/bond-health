# The scheduling agent, turn by turn

What actually happens between a patient saying something and Daphne replying, for the
**scheduling agent** — Voice (`voice_scheduling`, agent `05`) and Text (`ChatPanel`) under
either session mode. Both mediums are the same backend pipeline; voice just adds one extra
hop through ElevenLabs on each end. See `docs/app-guide.md` for the feature tour — this is
the plumbing underneath one specific piece of it.

Every stage below is real code, cited by file. Nothing here is aspirational.

---

## 0. The one-sentence version

**ElevenLabs turns speech into text and text into speech. Our backend, calling OpenAI twice
per turn, decides everything about what gets said. ElevenLabs never decides content.**

```
Patient speaks
     │
     ▼
ElevenLabs (ASR + turn-taking)  ──speaks Daphne's line, unmodified──▶  Patient hears it
     │                                                                        ▲
     │ "advance_scheduling" client tool call, message = patient's text        │
     ▼                                                                        │
frontend/src/useVoiceSchedulingConversation.ts                                │
     │                                                                        │
     │ POST /api/session/:id/message                                         │
     ▼                                                                        │
server/src/sessions.ts: exchange()                                            │
     │                                                                        │
     ├─ 1. extractTurn()      → OpenAI call #1 (facts + signals)              │
     ├─ 2. applyOperations()  → pure code, updates the ledger                 │
     ├─ 3. deterministic parsers (preference / escort / shipping) → pure code │
     ├─ 4. decide()           → pure code, one of ACT/ASK/STOP/HANDOFF        │
     ├─ 5. [ACT only] scheduleScreening() + invites → pure code, mock booking │
     └─ 6. composeReply()     → OpenAI call #2 (acknowledgment), maybe        │
     │                                                                        │
     ▼                                                                        │
reply.text  ───────────────────returned up the same chain───────────────────┘
```

Text mode is the same diagram with the top ElevenLabs box and the tool-call hop removed:
`ChatPanel.tsx` calls `POST /api/session/:id/message` directly.

---

## 1. Session creation — once, at "Start call" / first message

**Voice:** `frontend/src/useVoiceSchedulingConversation.ts`, `start()`.

Before the ElevenLabs call even connects:

```
Input:  patient.name, patient.age, sessionMode ("full" | "scheduling_only")
Call:   POST /api/session  { patientName, patientAge, mode }
Output: sessionId (uuid)
```

That `sessionId` is captured in a `ref` and closed over by the `advance_scheduling` tool
handler for the rest of the call — every subsequent turn reuses it. No OpenAI or ElevenLabs
call happens here; this just allocates an empty `Session` (`server/src/sessions.ts`
`createSession()`): an empty fact ledger, `askCounts: {}`, no resolution yet.

Voice also does one more thing text mode doesn't: it opens the actual ElevenLabs
`Conversation.startSession(...)`, passing `clientTools: { advance_scheduling: ... }` — a
function that runs **in the browser**, not on a public webhook. That's deliberate: it lets
this run against `127.0.0.1:8790` for local dev without ElevenLabs' cloud needing to reach
your machine.

---

## 2. Per-turn loop — everything below repeats once per patient utterance

### Step A — ElevenLabs: speech to text, and deciding whose turn it is (voice only)

Config: `agent_configs/05_daphne_scheduling_voice.create.json`.

- **ASR**: `scribe_realtime`, 16kHz PCM. Converts the patient's audio to text.
- **Turn-taking**: `turn_model: "turn_v3"`, `turn_timeout: 7.0s` — ElevenLabs decides when
  the patient has finished speaking, using its own model, not ours.
- **The agent's own LLM** (`gpt-5.4-mini`, `temperature: 0`, inside ElevenLabs' orchestration,
  *not* our backend) reads its system prompt and decides *what tool to call*. The prompt
  (quoted in full in the config's `prompt.prompt`) gives it exactly one instruction: call
  `advance_scheduling` with the patient's message verbatim, then speak back whatever it
  returns, word for word, adding nothing.

This is the one place ElevenLabs' own model makes a "decision" — and the decision is
deliberately content-free: *which tool to call*, never *what to say*. It cannot answer
clinically, cannot confirm a booking in its own words, and is explicitly told not to
paraphrase the tool's response.

```
Input to this step:  raw audio
Output of this step: { message: "<patient's utterance as text>" }  -- a tool call
```

### Step B — browser: the tool handler fires

`frontend/src/useVoiceSchedulingConversation.ts`, the `advance_scheduling` function
(lines ~90-112):

```
Input:  parameters.message  (string, from ElevenLabs)
Call:   sendMessage(sessionId, message)  →  POST /api/session/:id/message  { content: message }
```

This is a plain `fetch` to our own Express server. ElevenLabs is not involved again until
this function returns a string.

**Text mode enters the pipeline here too** — `ChatPanel.tsx`'s `onSend` calls the identical
endpoint directly, no ElevenLabs anywhere in that path.

### Step C — backend entry point

`server/src/index.ts`, `POST /api/session/:id/message` → `server/src/sessions.ts`,
`exchange(session, content)`.

```
Input:  session (existing, in-memory), content: string (the patient's raw text)
```

`exchange()` calls `appendTurn(session, "user", content)` first, which is steps 1–4 below,
then (if a decision came back) `composeReply()` (step 6), then records Daphne's reply as an
agent turn so the *next* extraction sees the question it's answering.

### Step 1 — extraction: OpenAI call #1

`server/src/extract-turn.ts`, `extractTurn()`. Called from inside `appendTurn()`
(`server/src/sessions.ts` line ~217).

This is the first of the two OpenAI calls per turn — model `gpt-5.4-mini` (or
`OPENAI_MODEL` if set), `reasoning_effort: "low"`, structured output (`json_schema`, strict
mode) via `server/src/llm.ts`'s `completeJson()`. **This call never sees the whole
transcript** — only a compact summary of facts already on file, plus this one turn.

```
Input:
  factsOnFile:        "f1 | self | screening | colonoscopy | never had one | status=never\n..."
                       (from ledger.ts's summarizeForPrompt() -- one line per live fact)
  precedingAgentTurn: "Would you like me to find you an appointment?"  (or null)
  patientTurn:        "Yeah, sure, book it."

Output (RawTurnExtraction, JSON-schema-enforced):
  operations: [
    // usually [] here -- "book it" carries no clinical content, see below
  ]
  signals: {
    tone: "neutral",
    hesitation: "none",
    readiness: "explicit_request",
    verbosity: "brief",
    request_type: "action",
    sensitive_topics: []
  }
```

A turn with real clinical content produces operations too, e.g. for
`"No bleeding, no weight loss, nothing like that"`:

```
operations: [
  { op: "add", subject: "self", category: "symptom", attribute: "rectal_bleeding",
    value: "no bleeding", status: "never", confidence: "high",
    source_quote: "No bleeding", ... },
  { op: "add", subject: "self", category: "symptom", attribute: "weight_loss",
    value: "no weight loss", status: "never", ... },
  { op: "add", subject: "self", category: "symptom", attribute: "bowel_habit_change",
    value: "nothing like that", status: "never", ... }
]
```

The system prompt is long and specific on purpose (full text in the file) — it's the thing
standing between "the patient said X" and "the record says X", covering: never infer a
diagnosis; a scheduling day/time is not a clinical fact; a request ("book it") is not a
fact; denials are facts and must be recorded, not dropped; `status: "never"` requires an
actual negation word in the quote (`coerceStatus()`, lines ~248-262, guards against the
model copying "never" onto a fact meant to contradict a denial).

**Failure mode:** if this call throws (network, malformed JSON, OpenAI outage), the error is
caught, logged to the session's trace as `extraction_failed`, and the turn simply produces no
ledger changes — it never breaks the call. See `appendTurn()`'s try/catch, lines 210-269.

### Step 2 — applying operations to the ledger: pure code, no model

`server/src/ledger.ts`, `applyOperations()`. No network call — this is where the model's
*proposals* become the actual record, and where invariants the prompt can't be trusted to
keep are enforced in code: no duplicate `subject:attribute`, subject-name normalization
("mom"/"mum"/"mother" → `"mother"`; a bare "nobody in my family" → `"family"`, not `"self"`),
category forced to `"family_history"` for anyone but the patient, and dedup — a second `add`
for something already on file is coerced into a merge instead of creating a duplicate.

```
Input:  session.ledger (mutated in place), the operations array from Step 1, turn index
Output: AppliedOperation[] -- e.g. [{ outcome: "added", factId: "f7", detail: "self: no bleeding" }]
```

This also updates `session.signals` to this turn's signals (overwriting the previous turn's
— signals are a snapshot of *this* turn's tone, not history).

### Step 3 — deterministic parsers: pure code, conditionally run

Still inside `appendTurn()` (lines 233-256), three narrow regex-based parsers run — never
through the LLM, because a day/time or a name is logistics, not clinical history that
belongs in the fact ledger:

| Parser | File | Runs when | Reads |
|---|---|---|---|
| `parseSchedulingPreference` | `preference.ts` | patient just asked to book, or already had | day of week / morning-afternoon / "soonest" out of raw text |
| `parseEscortReply` | `escort.ts` | the *previous* decision's gate was `"escort"` | a name and/or email out of raw text |
| `parseShippingAddress` | `shipping.ts` | the *previous* decision's gate was `"shipping"` | an address, or an explicit decline, out of raw text |

```
Input:  content (raw patient text), gated on session.decisions.at(-1)?.gate
Output: session.schedulingPreference | session.escortContact | session.shippingAddress
        (each set at most once per session; null while unanswered)
```

Example: `"Yeah, you can send an email to myfriend@gmail.com."` while the last decision's
gate was `"escort"` →
`parseEscortReply` → `{ provided: true, label: "myfriend@gmail.com", email: "myfriend@gmail.com" }`.

### Step 4 — the decision: pure code, no model, one function

`server/src/decide.ts`, `decide()`. Called as `runDecision()` from `appendTurn()`
(line 258). **This is the core of the whole app and the only place that produces the
outcome.** It is a plain function of state — same input, same output, every time — walking a
fixed list of gates in order and returning at the first one that fires:

```
Input (DecisionInput):
  facts, signals            -- from Steps 1-2
  alreadyResolved            -- session.resolution != null
  askCounts                  -- how many times each slot has been asked
  bookingRequested           -- sticky "have they said yes to booking" flag
  schedulingPreference, escortContact, shippingAddress  -- from Step 3
  patientTurn                -- raw text, used only by the already_resolved gate
  booking, waitlist          -- summaries of any existing resolution
  mode                        -- "full" | "scheduling_only"
  patientAge

Gates, in order (first match wins):
  1. scope             -- requestType === "clinical_judgment"          → STOP
  2. safety            -- any red-flag symptom currently active         → HANDOFF
     [if alreadyResolved: farewell / "what's the date" / generic reply  → ASK, and stop here]
  3. sufficiency        [mode "full" only] required slot unmet          → ASK (or HANDOFF if asked
                                                                            3x already -- "stuck")
  4. eligibility         [mode "full" only] guideline says not due yet  → ASK
  5. safety (symptoms)   never asked whether symptomatic                → ASK
  6. readiness          patient hasn't said yes / is ambivalent         → ASK
  7. scheduling          no day/time preference yet                     → ASK
  8. escort              no pickup contact asked yet                    → ASK
  9. shipping            no prep-kit address asked yet                  → ASK
  10. act                every gate above passed                        → ACT

Output (Decision):
  outcome: "ACT" | "ASK" | "STOP" | "HANDOFF"
  gate:    which one fired, e.g. "readiness"
  reason:  human-readable, for the Session Review pane / eval suite
  missingSlot: the one thing being asked for, or null
  say:     the authored sentence -- empty string on ACT (filled in during Step 5)
  bookWithinDays, recommendation, escortContact, shippingAddress: set only where relevant
```

Two things worth being explicit about, since they're the whole point of this file existing:

- **The `say` text for every non-ACT outcome is hardcoded in this file**, not generated. A
  model never writes "screening begins at 40" — that sentence, and the guideline math behind
  it, live in `server/src/requirements.ts`'s `recommendScreening()`, which is a table, not a
  prompt.
- `askCounts` is what turns a silent extraction miss into an honest `HANDOFF` instead of an
  infinite loop: `MAX_ASKS_PER_SLOT = 3` (line 83). Ask for the same slot a 4th time and the
  `"stuck"` gate fires instead.

### Step 5 — ACT's side effect: mock booking (only when the outcome is ACT)

`server/src/sessions.ts`, `runDecision()`, lines 333-372, calling into
`server/src/scheduler.ts`. Still no model call — this is deterministic, in-memory "booking."

```
Input:  decision.bookWithinDays, session.schedulingPreference, decision.shippingAddress
Call:   scheduleScreening(bookWithinDays, preference, shippingAddress)
          → searchSlots() -- deterministic mock slot inventory, two clinics
          → pickSlot()    -- matches the stated day/time, falling back to closest, then soonest
          → holdSlot() + confirmHold() -- returns a Booking with a confirmationId

Also, only on ACT:
  sendEscortInvite(decision.escortContact)   -- mocked; sets session.escortInvite
  sendPatientInvite(session.patientName, slot) -- mocked, booked case only

Output: SchedulingResult, one of:
  { status: "booked", booking: { confirmationId, slot, prepInstructions, prepKitShipment }, matchedPreference }
  { status: "waitlisted", waitlistId, reason, nextStep }

decision.say is then overwritten (still in code, not by a model) with the specific
booking/waitlist sentence, e.g.:
  "You're booked. Bay Endoscopy Center on Friday, September 25 at 9:00 AM. Your
   confirmation number is BH-DF56D33A, and I'll send the prep instructions over.
   I've sent a calendar invite to myfriend@gmail.com for the pickup. Clear liquids
   only for the full day before your appointment."
```

### Step 6 — composing the reply: OpenAI call #2 (conditional)

`server/src/compose.ts`, `composeReply()`, called from `exchange()` (line 522).

This is the second OpenAI call, and it's the one place a model is allowed to write words
that reach the patient — but only a short, tone-matching acknowledgment (≤18 words, no
digits, no clinical vocabulary, no questions) that gets prepended to `decision.say`.

```
Input:
  decision   -- from Step 4/5
  signals    -- this turn's tone/hesitation, from Step 1
  patientTurn
  isRepeat   -- true if this exact slot was already asked at least once before (askCounts >= 2)

Skipped entirely when: outcome === "ACT" (a booking confirmation doesn't need padding), or
  tone is neutral AND hesitation is "none" AND it's not a repeat -- i.e. most ordinary answers
  get no acknowledgment call at all, and cost nothing.

When it runs:
  Call:   OpenAI, gpt-5.4-mini, reasoning_effort "low", schema { acknowledgment: string }
  Output example: { "acknowledgment": "That's good to know." }

Guarded (guard(), lines 104-113) before use -- rejected if it contains a digit, a question
mark, is over 18 words, or matches clinical vocabulary (should/recommend/dose/cancer/symptom/
etc). A rejected or failed call falls back to a fixed template keyed by tone
(FALLBACK_ACK / FALLBACK_ACK_REPEAT), never to retrying or blocking.

Output (ComposedReply):
  text:  acknowledgment + " " + decision.say  (or just decision.say if no acknowledgment)
  acknowledgment, substance, guardTripped (for the Review pane)
```

The eval suite (`scripts/replay_session.mjs`) asserts `decision.say` survives into `text`
**character-for-character** — that's the property this split exists to make testable rather
than aspirational.

### Step 7 — back up the chain

`exchange()` records the reply as an agent turn (so the *next* extraction sees it as
`precedingAgentTurn`), and returns `{ reply, facts, signals, decision, resolution }`.

- **Text mode**: `ChatPanel` renders `reply.text` directly.
- **Voice mode**: the `advance_scheduling` tool handler returns `result.reply.text` as its
  string return value. ElevenLabs receives that string and — per its system prompt — speaks
  it **verbatim**, then waits for the next patient utterance and starts Step A again.

---

## 3. Who calls what, explicitly

| Call | Caller | Callee | Per turn? | Decides content? |
|---|---|---|---|---|
| ASR (speech→text) | ElevenLabs platform | ElevenLabs platform | every voice turn | no |
| Turn-taking / VAD | ElevenLabs platform | ElevenLabs platform | every voice turn | no (timing only) |
| Agent's own LLM (`gpt-5.4-mini` inside ElevenLabs) | ElevenLabs platform | ElevenLabs platform | every voice turn | no — only picks "call the tool" |
| `advance_scheduling` tool call | ElevenLabs platform | browser (client tool) | every voice turn | no — just a pass-through |
| `POST /api/session/:id/message` | browser | our Express server | every turn, both mediums | no — routing only |
| `extractTurn` (OpenAI #1) | our server | `api.openai.com` | every turn with non-empty patient text | facts/signals only, not the outcome |
| `applyOperations` | our server | our server (in-process) | every turn | no — mechanical |
| preference/escort/shipping parsers | our server | our server (in-process) | conditionally | no — regex |
| `decide()` | our server | our server (in-process) | every turn | **yes — this is the one decision-maker** |
| `scheduleScreening` + invites | our server | our server (in-process, mocked) | ACT only | no — mechanical, deterministic |
| `composeReply` (OpenAI #2) | our server | `api.openai.com` | conditionally (skipped on ACT, on neutral non-repeats) | tone of the acknowledgment only, never the substance |
| TTS (text→speech) | ElevenLabs platform | ElevenLabs platform | every voice turn | no |

**ElevenLabs is called on every voice turn for ASR/TTS/turn-taking, and its own internal LLM
is what decides "call the tool" vs. "don't" — but it never contributes a clinical or
scheduling decision.** All content — including the fact that a symptom question needs
asking, that a booking is or isn't due, and what a confirmed appointment's details are —
comes from `decide()`, a plain TypeScript function with zero model calls, fed by one OpenAI
extraction call and (sometimes) followed by one OpenAI acknowledgment call. Text mode is
identical minus the top and bottom ElevenLabs layers.

---

## 4. Latency, concretely

Per patient turn, voice mode:
- ElevenLabs ASR + turn-detection: near-instant once the patient stops talking (not our code).
- `extractTurn` (OpenAI #1): the dominant cost, roughly 0.5–2s.
- Ledger apply + parsers + `decide()`: microseconds — no I/O.
- `scheduleScreening` (ACT only): microseconds — in-memory mock, no external API.
- `composeReply` (OpenAI #2, conditional): another 0.3–1s when it runs at all.
- ElevenLabs TTS: starts streaming as soon as the tool call returns.

Total observed: roughly **1–3 seconds of silence** after the patient finishes speaking,
before Daphne starts talking — called out directly in `VoiceSchedulingPanel.tsx`'s
in-UI note and in `docs/app-guide.md`'s feature 9. This is the cost of running the decision
engine per turn instead of letting ElevenLabs' own model free-run — and exactly why
`voice_legacy` (Full intake's Voice) still exists for the case where that trade is wrong:
see `docs/app-guide.md` feature 14.

---

## 5. Where to look for each piece

| Concern | File |
|---|---|
| Session state, the per-turn orchestration (`appendTurn`, `runDecision`, `exchange`) | `server/src/sessions.ts` |
| OpenAI call #1 — fact/signal extraction | `server/src/extract-turn.ts` |
| The fact ledger itself (identity, dedup, contradiction) | `server/src/ledger.ts` |
| The gates — the one and only decision-maker | `server/src/decide.ts` |
| The guideline table + slot vocabulary the gates read | `server/src/requirements.ts` |
| Day/time, escort, shipping parsers | `server/src/preference.ts`, `server/src/escort.ts`, `server/src/shipping.ts` |
| Mock booking, invites, prep-kit shipment | `server/src/scheduler.ts` |
| OpenAI call #2 — acknowledgment | `server/src/compose.ts` |
| The one place either OpenAI call actually happens | `server/src/llm.ts` |
| Voice transport + the `advance_scheduling` tool handler | `frontend/src/useVoiceSchedulingConversation.ts` |
| Text transport | `frontend/src/useTextConversation.ts`, `frontend/src/components/ChatPanel.tsx` |
| The ElevenLabs agent's own config/prompt | `agent_configs/05_daphne_scheduling_voice.create.json` |
| End-to-end scripted proof of all of the above | `scripts/replay_session.mjs`, `harness_inputs/*.json` |
