# Daphne: from history-taking to resolution

Bond Health Founding AI Engineer coding exercise. **This document is the plan, written before the build.**
It will be rewritten into the submission README as the work lands.

For a tour of what's actually built — features, a walkthrough conversation, how to test it, honest
current limitations, and what comes next — see [`docs/app-guide.md`](docs/app-guide.md).

The exercise names the gap plainly: Daphne is warm and gathers family history beautifully, but
**she can't schedule anything or resolve anything when asked**. Everything below is aimed at that
sentence.

---

## Where I'm going deep (and where I'm not)

The brief asks for real depth in two or three areas rather than shallow coverage of four. My picks:

| Area | Depth | Why |
|---|---|---|
| **2. Clinical context** | **Deep** | Nothing above it is safe without it. You cannot decide to act on facts you can't query, and you can't decide *not* to act unless you can tell "she never said" from "she said no." |
| **3. Action with judgment** | **Deep** | This is the gap Bond actually named. It's also where the interesting failure modes live — acting on incomplete information is worse than not acting. |
| **4. Watching & improving** | **Real, smaller** | I have a specific opinion here, backed by a failure I already hit in prior work (below). Not just a dashboard. |
| **1. Empathy** | **Present, explained, not the showcase** | It's the one thing their current Daphne already does well. I'll implement a tone/readiness policy and explain it, but I won't pretend it's where I spent my judgment. |

The through-line: **an agent earns the right to act.** Empathy and memory are inputs to that decision,
not features sitting beside it.

---

## Scenario

**Colonoscopy screening — hesitation, then "can you help me get this scheduled?"** (option 2 in the brief).

Chosen over the skin/refill option because scheduling *is* the named gap, and because hesitation
forces the interesting decision: the agent has to distinguish "patient is asking me to act" from
"patient is still thinking out loud." Booking on ambivalence is a failure even when the booking
succeeds.

Per the brief, **no EHR exists**. The clinical picture is built from the conversation. That is a
feature for this design, not a limitation: the agent cannot look up when the last screening
happened, so it has to *know that it doesn't know* and ask — which is exactly the behavior being
tested.

One in-scenario refusal is kept deliberately: when prep medication comes up, Daphne must not advise
on it. A resolution layer with no visible stopping point isn't credible.

## Medium: text-first, voice adapter behind it

The decision layer, the fact ledger, and the eval suite are all modality-independent. Text makes the
loop deterministic and replayable inside the time cap, which is what makes area 4 possible at all.
Voice reuses plumbing that already exists here (signed-URL proxy, live transcript panel) and is a
stretch goal, not the core. Stated up front as the brief asks.

---

## Architecture

```
patient turn
     │
     ▼
┌─────────────────┐     per-turn structured pass (not a transcript re-read)
│  Daphne (LLM)   │────────────────┬───────────────────────────┐
│  tone policy    │                ▼                           ▼
└─────────────────┘        ┌──────────────┐            ┌──────────────┐
     ▲                     │ FACT LEDGER  │            │   SIGNALS    │
     │                     │  durable     │            │  ephemeral   │
     │                     │  queryable   │            │  tone,       │
     │                     │  sourced     │            │  readiness   │
     │                     └──────┬───────┘            └──────┬───────┘
     │                            │                           │
     │                            └────────────┬──────────────┘
     │                                         ▼
     │                              ┌─────────────────────┐
     │                              │  DECISION ENGINE    │
     │                              │  gates → one of:    │
     └──────────────────────────────│  ACT / ASK /        │
        next utterance is shaped    │  STOP / HANDOFF     │
        by the decision, not the    └──────────┬──────────┘
        other way around                       │
                                    ┌──────────▼──────────┐
                                    │ RESOLUTION (mocked) │
                                    │ hold → confirm → id │
                                    └──────────┬──────────┘
                                               │
                        every step emits a typed event ──▶ Session Review + eval
```

The important arrow is the one going back up. The agent's next sentence is a *consequence* of the
decision gate, not a free-form generation that the gate audits afterward.

### 1. Clinical context: two stores, one promotion rule

The brief asks for "durable facts split from softer conversational context." Two separate types,
never mixed:

- **`ClinicalFact`** — atomic, typed, patient-stated. Carries `confidence`, `source_quote`,
  `turn_id`, `provenance` (`patient_stated` | `document_upload`), and a lifecycle
  (`asserted → confirmed | contradicted | superseded`). Append-only and queryable. This is the record.
- **`ConversationSignal`** — tone, hesitation, pace preference, topics the patient flinched at,
  explicit readiness to proceed. Ephemeral. Shapes *how* Daphne speaks and *whether now is the
  moment*. Never enters the record.

**Promotion rule: a signal can never become a fact.** "She sounded worried about the prep" is not
"patient reports anxiety." A fact enters the ledger only through a structured call carrying a
verbatim source quote. Hearsay has no path into the record.

Extraction runs **incrementally, per turn**, emitting deltas against the current ledger — the brief
explicitly rules out "a re-read transcript," and a decision engine needs to query state mid-call
anyway. A cheap end-of-call reconciliation pass stays as a safety net (see prior art: reconciliation
catches real misses), but the live ledger is what decisions read.

### 2. Action: four outcomes, and the smallest question that unblocks one

Every turn resolves to exactly one of:

| Outcome | Meaning |
|---|---|
| **ACT** | Preconditions met, patient has asked to proceed → do the thing, produce a confirmation |
| **ASK** | Exactly one decision-relevant fact is missing → ask for that, nothing else |
| **STOP** | Out of scope (diagnosis, prescribing, dosing) → say so plainly |
| **HANDOFF** | Red flag or genuine ambiguity → route to a human, don't improvise |

Gates run in a fixed priority order before ACT is available — scope, safety, sufficiency, readiness,
scheduling, eligibility — so a red flag always outranks an explicit "book it," and being asked
nicely is never a reason to skip a safety check. The three that matter most for the brief's "acts
with judgment" ask:

- **Sufficiency** — are the required facts present at adequate confidence? (age; prior screening or
  explicit "never"; family history of colorectal cancer, which changes the interval; symptoms)
- **Safety** — anything suggesting this is not routine screening (bleeding, unexplained weight loss)
  flips to HANDOFF. A screening booking is the wrong resolution for a diagnostic problem.
- **Readiness** — from signals, not facts. Has the patient actually asked to proceed? Ambivalence
  blocks ACT and routes to a *conversational* move, not a booking.

A fourth, added after the first pass: **Scheduling** — once every other gate has passed, the agent
asks what day or time works before booking anything, rather than silently picking the earliest slot.
It's a gate, not a courtesy: skipping it means acting on an assumption ("any time is fine") the
patient never actually stated.

**Two isolated session modes, added after a live bug report asked for exactly this.** A session can
start as `full` (everything above) or `scheduling_only`, which skips sufficiency and eligibility
entirely and goes straight to the safety check and booking — for a patient who already knows they
need this (a referral, a standing order) and shouldn't be re-asked screening-history questions the
app has no way to act on differently anyway. The two modes are genuinely separate sessions, not a UI
skin on one conversation: mode is fixed at creation (`Session.mode` in `sessions.ts`), and scope and
safety run identically in either one — a red flag overrides an explicit booking request regardless of
which mode the session started in. See `docs/app-guide.md`'s Features §8 and
`harness_inputs/scheduling_only_skips_intake.json`.

The brief says optimize for fewest steps and shortest time to resolution. So ASK computes the
**minimum missing set** — the smallest set of facts that would unblock a decision — and asks for the
highest-value one. It does not run an intake questionnaire. This is where empathy and efficiency
happen to align: not interrogating someone is both kinder and faster.

Every decision records which gate fired and why. That log is the evidence for "knows what it doesn't
know," and it's what the eval suite asserts against.

Copy discipline carried over from prior art in this repo: **the model classifies, hardcoded
physician-authored tables author the patient-facing wording.** The LLM decides *which* pattern
applies; it never writes the clinical recommendation text.

### 3. Resolution (mocked, and honest about it)

A local mock scheduler: real-looking slot search → `hold` → `confirm` → confirmation id, prep
instructions, and a calendar artifact. Plus a deliberate unhappy path — no slots inside the clinical
window → waitlist plus a concrete next step — because a resolution layer with only a happy path
proves nothing.

Mocked: the scheduling backend, the clinic directory, insurance eligibility. Real: the decision
logic, the ledger, the gates, the eval. The submission README will state this line by line.

### 4. Watching and improving: two different questions

The brief separates these, so the design does too.

**"Did this go well?" — real-time.** Every turn emits typed events (fact captured, contradiction
detected, gate fired, decision made, refusal issued, question repeated). A **Session Review** pane
renders them as a human-readable trace beside the conversation: what Daphne knew, what she decided,
and why. Not a log tail. A reviewer can flag any turn inline.

**"How do we know it went well?" — offline.** A replay runner over scripted patient scenarios, with
assertions on **the decision, not the prose**:

- ambivalent patient + missing screening date → must `ASK`, must not `ACT`
- red-flag bleeding → must `HANDOFF`, must never book screening
- complete facts + explicit request → must `ACT` and return a confirmation id
- patient asks about prep dosing → must `STOP`

Prose gets a soft rubric score; decisions get hard assertions. Only the second kind can gate a change.

**The loop between them:** a flagged live turn becomes a new eval case. The eval suite gates changes
to prompts, gates, and tables.

**Why this beats "keep editing the prompt," with receipts.** In prior work in this repo I hit exactly
this wall: an agent had to cover a four-item checklist and kept short-circuiting. I hardened the
prompt; a replay run passed; it broke again on the next real call. Asking one model to re-derive
"have I covered all four?" from a growing transcript every turn is non-deterministic by construction.
It only became reliable when the checklist moved *out* of the prompt into tracked state. That's the
principle here: when something must be reliable, it becomes a gate with state, not a sentence in a
prompt. Prompts tune tone; structure enforces behavior. (Full incident write-up:
`agent_configs/03_daphne_family_history.create.json`'s `metadata.notes`.)

---

## Time-box

10 hours, per the brief. Stopping at the cap and reporting the remainder honestly.

| # | Phase | Est | Status |
|---|---|---|---|
| 0 | Repo hygiene, provider wiring, runnable skeleton | 0.5h | done |
| 1 | Fact ledger + signals + per-turn incremental extraction | 2.0h | done — [spec](docs/phase-1-spec.md), 7/7 acceptance |
| 2 | Decision engine: gates, four outcomes, decision log | 2.5h | done — 5 scenarios, 53/53 |
| 3 | Mock scheduling + resolution, including the unhappy path | 1.5h | done — booking + waitlist |
| 4 | Daphne conversation layer + tone/readiness policy | 1.0h | done — text loop closed |
| 5 | Session Review pane (real-time signal) | 1.5h | done — per-turn gate trace + flagging |
| 6 | Eval runner + ~8 scenario cases | 1.0h | done — `npm run eval`, 8 scenarios, 128/128 |
|   | **Total** | **10.0h** | |

README is written continuously, not at the end.

If something slips, phases 5 and 6 shrink before 1–3 do. A working decision layer with a thin
review pane beats a beautiful pane over an agent that can't decide anything.

Four things landed after phase 6, outside this table: a correctness fix to the scheduling-preference
parser (it was silently discarding a stated day/time in favor of "soonest" on certain phrasings —
see app-guide's "Features" §3), a confidentiality cleanup of the repo and its git history (see
"Open items" below), a second round of fixes from a live bug report that turned up four more
issues at once — two more preference-parsing gaps, a readiness-gate logic hole that made a bare "yes"
loop, a silent verbatim-repeat when the acknowledgment layer had nothing to say, and (the one that
actually mattered clinically) a relative's fact volunteered after an earlier family-history denial
never reaching the recommendation, even though it was captured correctly on the ledger — and a new
`scheduling_only` session mode, requested directly off the back of that same bug-report conversation,
that lets a session skip sufficiency/eligibility entirely and go straight to booking (see app-guide's
Features §8). See app-guide's "Resolved since earlier drafts of this document" for the fixes and
`family_history_correction_after_denial` / `scheduling_only_skips_intake` in the eval suite for the
regression cases. None of this was part of the original estimate; all of it was necessary before "it
works" meant what it should, or came directly from someone actually using the thing.

Two more landed after that: a pickup-escort ask (colonoscopy prep involves sedation, so before
booking the agent asks once who can pick the patient up, then books regardless of the answer — see
app-guide's Features §10 and `server/src/escort.ts`), and a second voice experience that, unlike the
original agent, actually drives the decision engine rather than observing it — an ElevenLabs agent
whose only instruction is to call a client tool with what the patient said and speak back exactly
what it returns (see app-guide's Features §9 and `frontend/src/useVoiceSchedulingConversation.ts`).
The latter changes the "Explicitly not doing" note on voice below, which described the state before
this addition.

## Explicitly not doing (and what I'd build next)

- **The original (legacy) voice agent, as anything more than a history-taking demo.** Its plumbing is
  real and verified — signed-URL round trip to ElevenLabs works — but it was always an observer:
  ElevenLabs' own model speaks from its own prompt there, and the ledger/decision engine only audit
  the call afterward, never steer it. That limitation is now specifically scoped to that one legacy
  agent, not to "voice" generally: a second voice experience (**Voice (scheduling)**, see app-guide's
  Features §9) closes exactly this gap by having a thin ElevenLabs agent delegate every turn to the
  same decision engine text mode uses, via a client tool. It has not yet been verified against every
  scenario over a real mic call end to end (see app-guide's "Future improvements" §3).
- **Medication refill scenario.** The natural second act, and the sharper safety case — refills need
  a prescriber relationship the agent can't verify. Strong candidate for "next."
- **Document upload** (pill-bottle photo → low-confidence facts needing confirmation). The
  `provenance` field is in the model specifically so this slots in without a migration.
- **Multi-session memory.** Single session only. The ledger is shaped to persist, but resume
  semantics (what's stale? what needs re-confirming?) is its own design problem.
- **Real integrations.** No pharmacy or provider portal. Mocked, and labeled.

---

## Prior art and provenance

This repo starts from a personal voice-agent prototype I built while preparing for conversations
with Bond: a four-stage ElevenLabs Daphne that captures personal and family history, extracts
structured health events, and renders an age-axis timeline. That work is **prior art, not the
submission** — the brief says to build from scratch and not reconstruct Bond's demo, and I agree
with the instruction.

What carries forward is infrastructure and hard-won lessons, not the history-taking chain:

- the React + Node local app shell and transcript UI
- the "LLM classifies, tables author the copy" discipline in
  [`server/src/followups.ts`](server/src/followups.ts)
- structured-output extraction plumbing in [`server/src/timeline.ts`](server/src/timeline.ts)
- the prompt-hardening failure that motivates the whole area-4 design

The history-capture agents are not the centerpiece of the submission and will not be presented as
one.

## Open items before any of this runs

These are real blockers, not paperwork.

1. **~~The repo does not run.~~ Resolved for the conversation path.** `server/.env` is wired to a
   personal ElevenLabs sandbox account (Creator tier, holds only the eight `Bond-Daphne-*` agents).
   Backend, frontend, and a live signed-URL round trip to ElevenLabs all verified. The server now
   loads its own `.env` via `--env-file-if-exists`, so `npm run dev` works from a clean clone
   without a wrapper script.
2. **~~Extraction has no provider.~~ Resolved.** Both model passes moved off a previous employer's
   AWS Bedrock account onto a personal OpenAI key, behind one module
   ([`server/src/llm.ts`](server/src/llm.ts)) so the provider is a single edit rather than a hunt
   through call sites. The AWS SDK dependency is gone. `/api/summarize` verified end to end: correct
   extraction, both guideline rules, a familial cluster, a symptom referral, and a data gap all fire
   as they did on Bedrock.
3. **~~Prune before sharing.~~ Resolved.** `transcripts/` contained Bond's NDA'd demo transcript and
   my own interview-prep notes; the prior-art doc in `docs/` referenced a previous employer's
   customers and internal paths. Neither belonged in a submission. Both are removed from the working
   tree, and git history was rewritten (`git filter-repo`) to remove them from every prior commit too
   — this repo's history no longer contains that material anywhere.
4. **Cost.** Per-turn extraction plus a decision pass on every turn is more model calls than the old
   post-call design. The ElevenLabs sandbox has roughly 93k characters left on its monthly quota,
   which is enough for demo and eval runs but not for careless looping. If it becomes a real
   constraint the brief says to say so rather than quietly cut scope.

## Running it

```bash
cp server/.env.example server/.env   # set BOND_ELEVEN_LABS_API_KEY and OPENAI_API_KEY
(cd server && npm install && npm run dev)      # http://127.0.0.1:8790
(cd frontend && npm install && npm run dev)    # http://127.0.0.1:5190
```

Or `scripts/restart_local_servers.sh` to do both, with port cleanup and health checks.

All verified from this checkout:

- `/api/health` and `/api/agents` — 8 agents
- `/api/signed-url` — real round trip to ElevenLabs, returns a `wss://` conversation URL. A voice
  call needs only a microphone and browser permission.
- `/api/summarize` — extraction, age timeline, and insights on a personal OpenAI key
- `/api/session/*` — live per-turn extraction into the fact ledger

Only two secrets are needed, both personal: an ElevenLabs key for voice and an OpenAI key for
everything else. No employer account is involved anywhere in this repo.

### Replaying a scenario

No microphone needed — this drives the live session endpoints from a scripted transcript and
asserts on the resulting ledger.

```bash
node scripts/replay_session.mjs harness_inputs/*.json
```

It prints each turn's ledger operations, signals, and decision, then the final fact table,
resolution, and acceptance checks. Exit code is non-zero if any check fails, so it works as a gate.
Roughly one small model call per patient turn, 1–5s each, all off the conversational path.

Eight scenarios, ~120 assertions (the exact count varies by a check or two run to run — see the
signal-classification note in `docs/app-guide.md`'s Limitations), one per gate plus two regression
cases:

| Scenario | Asserts |
|---|---|
| `text_mode_full_journey` | the real product path — engine-authored replies, and authored clinical wording surviving verbatim |
| `colonoscopy_never_screened` | happy path — stated negative, self-correction, booking with a confirmation id |
| `red_flag_bleeding` | safety outranks an explicit booking request → HANDOFF, never ACT |
| `ambivalent_patient` | complete facts are not consent → ASK via readiness, never ACT |
| `out_of_scope_dosing` | a warfarin dosing question → STOP, whatever else is true |
| `no_slots_waitlist` | clinical window inside the clinic's lead time → waitlist with a next step |
| `family_history_correction_after_denial` | a relative's fact volunteered after an earlier family denial still changes the recommendation; a bare "yes" is accepted without a repeat; "fridays after noon" parses correctly |
| `scheduling_only_skips_intake` | a `scheduling_only` session never asks the sufficiency questions, and safety still overrides it regardless |

Or `npm run eval` from `server/`.

Assertions are on decisions and state, never on wording. Scenarios declare their own expectations,
so a new case is a JSON file rather than a code change.

### The loop between live review and offline eval

The Session Review pane shows, per turn, which gate fired and why — the thing a transcript can't
tell you, since "I'd rather not book that yet" reads identically whether the agent respected
hesitation or failed to notice it could act.

Flagging a turn there and hitting **Export as eval case** downloads the session in the same format
`harness_inputs/` uses, ready to run. Observed outcomes are filled in as expectations, except on
flagged turns, which are marked `FIXME` — for a flagged turn the observed outcome is by definition
the wrong one, and exporting it as the expectation would lock in the bug that got flagged.

Verified end to end: a live session exported to JSON and replayed as a regression case passes 9/9
without hand-editing.
