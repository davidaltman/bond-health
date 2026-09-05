# Phase 1 — per-turn incremental extraction

Build spec for the clinical-memory layer. See [`../README.md`](../README.md) for how this fits the
overall plan.

## What changes

`/api/summarize` today sends the whole finished transcript to one model call that returns the
complete event list. Every run starts from nothing, and nothing is known until the call ends.

Incremental means: after each patient turn, one small model call sees **that turn plus the facts
already on file** and returns **operations against the ledger** — add this, confirm that, this
contradicts fact `f7` — instead of a fresh list.

|  | today | after Phase 1 |
|---|---|---|
| input | whole transcript, grows all call | one turn + compact state |
| output | full replacement array | diff against the ledger |
| timing | after the call ends | during the call |

The point is timing. A decision engine cannot wait until the call is over to work out whether it
may book an appointment.

## Extraction stays out of the conversational path

The prior prototype tried mid-call capture as an agent tool the LLM waited on. It produced
15-second dead air and made Daphne re-ask questions she had just asked (see
`agent_configs/03_daphne_family_history.create.json`'s `metadata.notes`, "Fixes applied 2026-08-16").

So extraction runs server-side and out of band. Turns are posted as they arrive; the conversation
never awaits a result. A slow or failed extraction degrades what the system *knows*, never what the
patient *hears*.

## Data model

Two stores. A signal can never become a fact.

**Durable — `ClinicalFact`.** Append-only, queryable, every entry carrying a verbatim quote.

```ts
interface ClinicalFact {
  id: string;                      // f1, f2, ... server-assigned, stable
  subject: string;                 // "self" | "mother" | ...
  category: "condition" | "symptom" | "medication" | "procedure"
          | "screening" | "family_history" | "allergy";
  attribute: string;               // canonical key, e.g. "colonoscopy"
  value: string;
  qualifiers: {
    onsetAge: number | null;
    lastOccurred: string | null;
    status: "active" | "resolved" | "never" | "unknown";
  };
  confidence: "high" | "medium" | "low";
  provenance: "patient_stated" | "document_upload";
  sourceQuote: string;             // required
  firstTurn: number;
  lastTurn: number;
  state: "asserted" | "confirmed" | "contradicted" | "superseded";
}
```

**Ephemeral — `ConversationSignals`.** Recomputed each turn, never written to the record.

```ts
interface ConversationSignals {
  turn: number;
  tone: "neutral" | "worried" | "frustrated" | "embarrassed" | "rushed";
  hesitation: "none" | "mild" | "strong";
  readiness: "not_raised" | "exploring" | "ambivalent" | "ready" | "explicit_request";
  verbosity: "brief" | "normal" | "detailed";
  sensitiveTopics: string[];
}
```

`readiness` is what the Phase 2 ACT gate reads. Booking requires `explicit_request`; `ambivalent`
blocks it.

## The distinction that matters most

The ledger separates **"never" from "not mentioned."**

"I've never had a colonoscopy" is a fact with `status: "never"` — real information, enough to act
on. No colonoscopy fact at all means the system is ignorant, and the only correct move is to ask.

A post-call transcript extractor blurs these, because both end up as an absent row. Keeping them
apart is what lets Phase 2 honestly answer "do I know enough to act?", which is the behavior the
exercise is testing.

## Deduplication is enforced in code

The model proposes `add`. The server computes `subject:attribute`, and if a live fact already has
that key, rewrites the operation into a `confirm` or `refine`. The model never gets to create a
duplicate by forgetting what it already recorded.

Same principle as the family-history incident: when something has to be reliable it becomes a rule
with state, not a sentence asking a model to remember. Operations referencing a fact id that does
not exist are dropped and recorded, never guessed at.

## Components

| File | Responsibility |
|---|---|
| `server/src/ledger.ts` | types, identity/merge rules, `applyOperations` |
| `server/src/extract-turn.ts` | the per-turn model pass: prompt + strict schema |
| `server/src/sessions.ts` | session registry, per-session serialization |
| `server/src/index.ts` | session endpoints |

Endpoints:

- `POST /api/session` → `{ sessionId }`
- `POST /api/session/:id/turn` with `{ role, content }` → applied operations, current facts, signals
- `GET /api/session/:id` → full state plus trace

Only patient turns trigger extraction; agent turns are stored and passed as context so the model can
tell what question is being answered. Turns are serialized per session with a promise chain, so they
apply in order even when they arrive faster than the model responds. Storage is an in-memory `Map`
for this exercise — the shape is persistable, but session resume is out of scope.

`/api/summarize` stays, demoted to an end-of-call reconciliation pass that catches what the live
pass missed.

## Acceptance

Replay a scripted transcript turn by turn and assert on the resulting ledger:

1. "I've never had a colonoscopy" produces a `never` fact, not silence.
2. A later correction marks the earlier fact `contradicted` rather than leaving two contradictory rows.
3. Restating a known fact confirms it instead of adding a duplicate.
4. Hesitation followed by an explicit request moves `readiness` to `explicit_request`.

## Out of scope for Phase 1

Decision engine (Phase 2), scheduling (Phase 3), Session Review pane (Phase 5). Phase 1 ends with
facts and signals queryable mid-call, plus a plain debug view.

Cost is roughly one small call per patient turn, about ten per demo conversation.
