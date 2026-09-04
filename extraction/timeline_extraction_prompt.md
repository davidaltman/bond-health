# Timeline Extraction LLM — Design

**Purpose:** the authoritative pass that turns a finished (or in-progress) Daphne conversation transcript into structured `health_events` rows for the live timeline. This is intentionally **decoupled from the conversational agent's own `log_health_fact` tool calls** (see the four agent configs in `../agent_configs/`) — those tool calls are an optimistic, real-time UX accelerant; this extraction pass is the source of truth, run at minimum once at end-of-call, and optionally on a rolling basis during the call.

This follows a general separation-of-concerns principle from production conversational-AI systems: the conversational ElevenLabs agent's job is to have a good conversation, not to be trusted as the final data-quality gate. A separate, decoupled pipeline does the authoritative classification/extraction after the fact, reconciling against whatever the live conversation captured optimistically rather than trusting it outright.

---

## When It Runs

| Trigger | Mode | Purpose |
|---|---|---|
| Every ~15–20 seconds during the call, or after each agent-stage transfer | **Rolling** | Keep the live timeline UI reasonably fresh without waiting for call end |
| Immediately when the call reaches a terminal state (`Bond-Daphne-Summary-v1` calls `end_call`) | **Final/authoritative** | Reconcile everything — this run's output is what actually gets written as final `health_events` and triggers `followup_tasks` generation |

Both modes call the same extraction prompt below; the only difference is whether the input is the full transcript-so-far (rolling) or the complete transcript (final).

---

## Input

1. **Full turn-by-turn transcript**, speaker-labeled (`patient` / `daphne`), in order.
2. **Facts already logged via `log_health_fact` tool calls during the call** (if any) — passed in as a list, so the extraction LLM can reconcile rather than duplicate, not re-derive from scratch every time.
3. **Known patient context** (age, sex, if already on file) — needed later for the guideline-rule matching in `followup_task_rules.md`, not strictly needed by this extraction step itself.

---

## Extraction System Prompt

```
You are a clinical history extraction system. You will be given a transcript of a
conversation between a patient and Daphne, a voice health assistant, along with a
list of facts that were already logged in real time during the call.

Your job is to produce a complete, deduplicated, reconciled list of structured
health events mentioned anywhere in the transcript — personal and family history.

RULES:
1. Extract only what the patient actually stated. Never infer a diagnosis, never
   add clinical interpretation, never assume something not said.
2. If a fact appears in both the transcript and the already-logged list, merge
   them into one entry rather than duplicating — prefer the more complete/specific
   description, but flag a conflict if the two sources disagree on a material
   detail (e.g. logged says "age 30", transcript context implies "age 40").
3. Assign `person` as "self" for the patient's own history, or the specific
   relation ("mother", "father", "sibling", etc.) for family history. Never guess
   a relation that wasn't stated.
4. Assign a `confidence` of "high" only when the patient stated the fact clearly
   and specifically (named condition, clear approximate age/date). Use "medium"
   or "low" for vague, hedged, or incomplete statements.
5. Do not fabricate an `approx_age` if none was given or inferable from context
   (e.g. "when I was in college" is inferable if age is known; a bare "a while
   ago" is not — leave it null).
6. Output ONLY the JSON object below. No prose, no explanation.

OUTPUT SCHEMA:
{
  "health_events": [
    {
      "person": "self" | "<relation>",
      "category": "surgery" | "medication" | "condition" | "symptom" | "family_history",
      "subcategory": "<string or null>",
      "description": "<normalized description>",
      "approx_age": <integer or null>,
      "still_living": <boolean or null>,   // family history only
      "confidence": "high" | "medium" | "low",
      "source_quote": "<the specific patient utterance this was extracted from>",
      "conflict_with_logged_fact": <boolean>,
      "conflict_note": "<string or null>"
    }
  ],
  "session_summary": "<2-3 sentence plain-language summary of the whole conversation, for the physician review queue and for Daphne's own spoken recap in the Summary stage>"
}
```

---

## Reconciliation Logic (Write Path)

Directly reusing the write-path discipline from the Q9 longitudinal-memory answer — **never let raw LLM output go straight into permanent memory**:

```
1. Run extraction (rolling or final) → candidate health_events list
2. For each candidate event:
   a. If it matches an existing health_events row (same person + category +
      similar description) → update in place, keep the higher-confidence source
   b. If conflict_with_logged_fact is true → do NOT silently overwrite; write
      both versions with a `needs_review` flag and surface to the physician
      review queue rather than guessing which is correct
   c. If it's new → insert as a new health_events row
3. On the FINAL run only:
   a. Mark the session's health_events as "reconciled" (vs. "provisional" from
      rolling passes)
   b. Trigger follow-up task generation (see followup_task_rules.md)
   c. Persist session_summary for physician review + Daphne's spoken recap
```

---

## Model Choice

A **fast, cheap model** is appropriate here (this is structured extraction, not open-ended reasoning). Reserve a larger/slower model, if needed at all, for the referral-classification step in `followup_task_rules.md`, which requires more nuanced semantic judgment than flat extraction.
