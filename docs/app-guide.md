# App guide: features, limitations, and how to actually poke at this thing

This is the practical companion to the [README](../README.md), which explains *why* the system is
built this way. This document is for someone sitting down with the running app: what it does, what
it doesn't, how to drive it, and what's honestly still wrong with it as of this writing.

Written mid-build, kept accurate rather than aspirational. Where something is broken or unfinished,
it says so.

---

## What this is

A text-first (with a voice adapter) health-intake agent for one scenario: colonoscopy screening. It
talks to a patient, builds up a structured record of what they've told it, decides — via explicit,
inspectable gates — whether it's allowed to book a screening, and if so, books one against a mocked
clinic calendar. Every decision is logged with the gate that fired and why, and any turn can be
flagged and replayed as a regression test.

It is a demo built for a hiring exercise, not a product. Read the "Limitations" section before
trusting anything it says about a real patient.

---

## Features

### 1. A fact ledger that isn't a transcript

Every patient turn goes through a small model call that extracts *changes* to a structured record —
not a summary, a diff. Facts have a subject (`self`, `mother`, `family`, ...), a category, a status
(`active` / `resolved` / `never` / `unknown`), a confidence, and a verbatim source quote. Crucially,
**"never had one" and "never came up" are different states** — the whole system depends on being able
to tell them apart, because only one of them means it's safe to stop asking.

Corrections are tracked, not overwritten: contradicting a fact leaves the old one on file marked
`[contradicted]` and links to the fact that replaced it, so the review pane can show *why* the record
changed, not just its current state.

See it: the **"What Daphne knows"** panel (left column), and `server/src/ledger.ts`.

### 2. A decision engine with four possible outcomes and a fixed gate order

Every patient turn resolves to exactly one of `ACT`, `ASK`, `STOP`, or `HANDOFF`. The gates run in a
fixed priority order — scope, safety, sufficiency, readiness, scheduling, eligibility — so a red flag
always outranks an explicit "book it," and being asked nicely is never a reason to skip a safety
check. Every decision records the gate, the reason, and which fact IDs it was based on.

See it: the **"Decision"** panel, and `server/src/decide.ts`.

### 3. A scheduling gate that asks before it acts

As of this session, the engine no longer books the first available slot the instant every other gate
passes. It asks the patient what day or time works, parses the answer deterministically (no model
call — see `server/src/preference.ts`), and searches a mocked two-clinic, morning/afternoon slot
inventory for the closest match. If it can't find an exact match, it books the closest thing and says
so, rather than pretending it matched.

**Fixed as of this writing:** a reply like *"Wednesday afternoon works for me"* used to get misread —
the phrase "works for me" was meant to catch "I don't care, whatever's soonest," but it also just
means "yes, that specific thing is fine," and the code preferred the wrong reading, silently
discarding the stated day/time in favor of the earliest slot. `preference.ts` now only treats
affirmation phrases ("works for me," "up to you," "you pick") as "no preference" when no day/time was
also named in the same reply — unambiguous phrases (`asap`, `soonest`, `as soon as`) still always mean
soonest. Pinned down by `scripts/test_preference.mjs`, a deterministic unit check with no server, no
model call, and no dependence on the real calendar date (see the day/time-matching limitation below
for why that last part matters).

### 4. Mock resolution with an honest unhappy path

`server/src/scheduler.ts` simulates a real `search → hold → confirm` sequence rather than one atomic
`book()` call, specifically so a hold can expire between steps. There is a genuine failure path: the
mock clinic has no capacity inside 21 days, so a patient whose clinical urgency window is tighter than
that (elevated risk, long overdue) gets waitlisted with a concrete next step instead of a booking. This
isn't a random failure injection — it's a property of the scenario, so the eval suite can assert on it
reliably.

### 5. A conversation layer that can't drift from the decision

In **text mode**, Daphne's reply is built from two parts: a short, tone-adaptive acknowledgment
written by a model (which is explicitly forbidden from containing any clinical content, numbers, or
questions — a guard function rejects and falls back to a template if it tries), followed by the
decision engine's authored substance, appended verbatim. The eval suite asserts the authored text
survives character-for-character into what the patient reads. There's no path for the model to
quietly soften "screening begins at 40" into "usually around your forties."

**Voice mode** is structurally different: ElevenLabs' own conversational model speaks from its own
prompt, and the ledger/decision engine run alongside as an *observer*, updating the side panels a beat
after Daphne has already spoken. The engine doesn't steer voice calls; it audits them.

### 6. A live review pane, and a loop back into the eval suite

The **"Session review"** pane (text mode only) shows, per turn, what was said, what the ledger did
with it, which gate fired, and why — the thing a transcript alone can't show, since "I'd rather not
book that yet" reads identically whether the agent respected hesitation or simply never noticed it
could act. Any turn can be flagged with a note. **"Export as eval case"** downloads the whole session
in the same JSON format the scripted scenarios use, with observed decisions filled in as expectations
— except flagged turns, which are marked `FIXME` rather than have the (known-wrong) observed outcome
locked in as correct.

### 7. A scripted eval harness

`node scripts/replay_session.mjs harness_inputs/*.json` (or `npm run eval` from `server/`) drives the
live HTTP endpoints — no mocking of the engine itself — against six scripted scenarios and asserts on
decisions and ledger state, never on prose wording. Exit code is non-zero on any failure, so it works
as a gate on changes to prompts, gates, or tables.

---

## A tour

Start both servers (from repo root):

```bash
cp server/.env.example server/.env   # fill in OPENAI_API_KEY; BOND_ELEVEN_LABS_API_KEY only if you want voice
(cd server && npm install && npm run dev)     # http://127.0.0.1:8790
(cd frontend && npm install && npm run dev)   # http://127.0.0.1:5190
```

Open `http://127.0.0.1:5190`. You'll see a header with a **Text / Voice** toggle (Text is the default,
and the one that actually demonstrates the decision engine driving the conversation), three columns,
and — in text mode — a chat box at the center.

**Left column:** patient name/age controls and call controls (voice mode only, mostly irrelevant in
text mode), and **"What Daphne knows"** — the live fact ledger, grouped by who the fact is about, with
a "how they sound" strip underneath showing tone/hesitation/readiness. That strip is explicitly
labeled "not part of the record" — it's signal, not fact, and it never becomes one.

**Center column:** the conversation (chat box in text mode, transcript in voice mode), then the
**Decision** panel showing the outcome pill (ACT/ASK/STOP/HANDOFF), which gate fired, why, and — once
a booking or waitlist exists — the confirmation ID and prep instructions, or the waitlist ID and next
step. Below that in text mode, the **Session review** pane with the per-turn trace and flag buttons.

**Right column:** a summary panel for the separate post-call timeline feature (`/api/summarize`) —
this is legacy from the prior-art prototype (see README's "Prior art" section), not part of the
decision-engine story. Ignore it unless you're specifically looking at the age-timeline extraction.

### Try this conversation, typed into the chat box one line at a time:

1. `My doctor keeps bringing up a colonoscopy and honestly I keep putting it off.`
   → watch the Decision panel: `ASK via sufficiency`, asking whether you've had one.
2. `No, never. I've never had a colonoscopy or any of those stool tests.`
   → still `ASK via sufficiency`, now asking about family history.
3. `My father had colon cancer. He was 52 when they found it.`
   → `ASK via safety` — symptom check, because screening is now indicated and symptoms haven't been
   asked about yet.
4. `No bleeding, no weight loss, nothing like that.`
   → `ASK via readiness` — every fact needed is on file, but you haven't asked to proceed. Watch the
   panel show the guideline rationale (screening starts at 40, not 45, because of family history).
5. `Yes, please book it.`
   → `ASK via scheduling` — new as of this session. It'll ask what day/time works.
6. `Tuesday morning, if possible.`
   → `ACT`, with a confirmation ID and prep instructions in the Decision panel.

Now try derailing it — `hit "New session"` first, then:

- Say **"I've had blood in my stool the last few weeks"** early on, then ask to book anyway → watch
  it `HANDOFF via safety` and refuse to book a *screening* for what's now a diagnostic problem, even
  when explicitly asked.
- Ask **"should I stop my warfarin before the prep?"** → `STOP via scope`, whatever else is true.
- Say something ambivalent after everything else is known — *"I don't know, my sister said the prep
  was awful"* → `ASK via readiness`, and the reply is a conversational move, not a re-pitch.

Flag any turn in the Session review pane with a note, then hit **Export as eval case** — it downloads
a JSON file in exactly the shape of the files in `harness_inputs/`.

---

## How to test it

**Manually, in the browser:** the tour above. This is the only way to see the acknowledgment/guard
behavior and the voice-mode observer relationship live.

**Scripted, from the terminal — the real regression gate:**

```bash
npm run eval   # from server/: runs both of the below in sequence
```

which is two layers:

```bash
npx tsx scripts/test_preference.mjs             # deterministic, no server, no clock, <1s
node scripts/replay_session.mjs harness_inputs/*.json   # live server, real model calls, ~1min
```

`test_preference.mjs` exists specifically because the scheduling-preference parsing bug (above) has
nothing to do with dates or the server, but the scenario suite's booking assertions inherit whatever
day it happens to be run on — asserting the exact parsing bug there would have meant a regression test
that only fails on 5 days out of 7 (see the day/time-matching limitation below). Pure logic bugs get
pure unit checks; anything that touches the mock calendar goes through the live-server suite instead.

The live-server suite drives the actual server over HTTP (no engine mocking), prints every turn's ledger operations,
signals, and decision, then a final fact table, resolution, and pass/fail per assertion. ~1-5 seconds
per patient turn (each is a real model call), roughly a minute for all six scenarios. Non-zero exit on
any failure. `harness_inputs/bond_daphne_repetition_regression_2026-08-16.json` is a leftover from the
prior-art prototype and is deliberately skipped (no `turns` array) — it's not part of this suite.

Six scenarios today, one per gate family:

| Scenario | Proves |
|---|---|
| `text_mode_full_journey` | the real product path end to end, plus verbatim authored-text survival |
| `colonoscopy_never_screened` | happy path through every gate, including the new scheduling ask |
| `red_flag_bleeding` | safety outranks an explicit booking request |
| `ambivalent_patient` | complete facts are not consent |
| `out_of_scope_dosing` | a clinical question gets `STOP`, unconditionally |
| `no_slots_waitlist` | the unhappy resolution path — waitlist with a real next step |

**The live-to-regression loop:** flag a turn in the Session review pane, export it, drop the file into
`harness_inputs/`, fill in the `FIXME` with what *should* have happened, and it runs with everything
else. This was verified working end-to-end earlier in the build (9/9 on a round-tripped export) but
hasn't been re-verified since the scheduling-gate changes.

---

## Limitations

Organized by how much they matter.

**Would matter in a real deployment:**

- **Everything about scheduling is mocked.** Two fake clinics, a hardcoded slot pattern, no real
  clinic integration, no insurance eligibility check.
- **No PCP or referral is modeled anywhere.** The engine will book a colonoscopy the moment its gates
  pass; it never checks whether the patient has a PCP relationship or a referral on file. This is a
  known, deliberately unaddressed gap — see "Future improvements."
- **No EHR.** Every fact comes from what the patient says in this conversation. This is a stated
  constraint of the exercise, not an oversight, but it means the agent has no way to catch a patient
  misremembering or contradicting an actual record.
- **Single session only.** Nothing persists across calls. The `provenance` field on facts is shaped to
  support multi-session resume later, but the "what's stale, what needs re-confirming" logic doesn't
  exist yet.
- **The scheduling-preference bug above.** Currently mid-fix.

**Would matter before this repo is shared with anyone at Bond:**

- **`transcripts/` still contains 13 files of interview-prep notes**, including one named after what
  appears to be a real person's name, and `docs/prior-art-daphne-history-demo.md` still names a
  previous employer. Both are already committed to this repo's git history. The README has flagged
  this as an open item since early in the build; it is still open.

**Would matter for someone extending this, but not for evaluating the demo today:**

- **Cost and latency are real, not hidden.** Per-turn extraction plus a decision pass is a genuine
  LLM call on every patient turn (1-5 seconds each in the eval logs), which is strictly more model
  calls than a naive "summarize the transcript once at the end" design. This is a deliberate trade —
  see the README's "watching and improving" section — but it's not free, and voice-mode extraction
  running fire-and-forget means a slow or failed extraction degrades what the system *knows*, silently,
  rather than what the patient *hears*.
- **Day/time matching depends on the real calendar date** the server happens to be running on
  (`scheduleScreening` defaults to `new Date()`), so "does Tuesday actually have an opening" isn't
  fully deterministic across days the way the rest of the eval suite is. Doesn't currently cause a
  scenario to flip, but it's a latent flakiness source worth knowing about.
- **LLM signal classification is occasionally noisy**, independent of anything above — the same
  sentence ("Yes, please book it") has been observed to classify as `readiness=explicit_request` on
  most runs and `readiness=ambivalent` on others. Documented, not solved; the gate design tolerates it
  (a missed request just gets asked again) but doesn't eliminate it.
- **The README is behind the code.** It doesn't mention the scheduling gate, and its assertion count
  (74) is stale (76 now). It also contradicts itself — "explicitly not doing voice" a few paragraphs
  above a "voice signed-url round trip verified" claim.

---

## Expectations — what this is and isn't

- **It's a decision-quality demo, not a clinical product.** The guideline table in `requirements.ts`
  is a hardcoded, physician-style approximation for demo purposes, not something anyone should
  actually be screened against.
- **"Mocked" is stated, not hidden.** Anywhere the system fakes something — the clinic calendar, the
  scheduling backend, insurance — it says so in comments and in the README, on the theory that an
  honest mock is worth more than a demo that quietly implies more integration than exists.
- **Assertions are on decisions and state, never on prose.** The eval suite doesn't check that Daphne
  "sounds nice" — it checks that the right gate fired. Tone is a soft rubric elsewhere, deliberately.
- **It will tell you what it doesn't know, rather than guess.** This is the single property the whole
  design optimizes for. If you're evaluating whether it "works," the sharpest test isn't "did it book
  the appointment" — it's "did it correctly *refuse* to, on the red-flag and out-of-scope scenarios."

---

## Future improvements, and what comes first

In the order I'd actually do them, with the reasoning:

1. **Finish and verify the scheduling-preference fix.** In progress right now. This is a correctness
   bug in code shipped this session, not a nice-to-have — it silently discards what the patient said,
   which is exactly the failure class the rest of this system exists to prevent. Nothing else on this
   list should land on top of an unverified fix.
2. **The confidentiality scrub.** Flagged as an open item since early in the build, never executed.
   Low effort, high downside if skipped — this blocks sharing the repo with anyone, not just polishing
   it.
3. **Add scenarios for the two untested scheduling paths:** a preference that can't be matched exactly
   (the "closest opening" messaging), and the exhausted-preference fallback (three unparseable answers
   → silently book soonest). Both paths exist in code; neither has a regression test, which is exactly
   the gap this project's own eval philosophy argues against leaving open.
4. **PCP / referral gate.** Currently a silent assumption. Even a minimal version — the agent states
   out loud that this needs a PCP referral, without actually gating on it — would convert a silent gap
   into a stated one, which is the standard the rest of the decision engine holds itself to.
5. **Reconcile the README against the running code**, including the voice-mode contradiction and the
   stale assertion count. Cheap, and it's the first thing a reviewer reads.
6. **Verify voice mode against the new scheduling gate.** It's wired (fire-and-forget postTurn already
   updates the Decision panel during voice calls per the App.tsx medium toggle), but nobody has run an
   actual mic call through the new "what day/time works" exchange to confirm it behaves sanely when
   Daphne's own model — not the decision engine — is choosing what to ask and when.
7. **Medication refill scenario**, as the README already names it: the natural second scenario, and a
   sharper safety case, since refills implicate a prescriber relationship the agent has no way to
   verify — a different flavor of the same "don't act past what you actually know" problem this system
   is built around.
8. **Document upload** (a photo of a pill bottle or referral letter → low-confidence facts needing
   confirmation). The `provenance` field on `ClinicalFact` already distinguishes `patient_stated` from
   `document_upload` specifically so this slots in later without a schema migration — it's just not
   built.
9. **Multi-session memory.** Deliberately last: "what's stale, what needs re-confirming" after a real
   gap in time is its own design problem, not a small extension of the current single-session ledger.
