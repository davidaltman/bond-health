# Follow-Up Task Generation — Design

**Purpose:** turn reconciled `health_events` (see `timeline_extraction_prompt.md`) into the dashboard task list — vaccine/screening reminders and physician referrals. Two distinct engines, matching the Theta-engine philosophy already established in Bond interview prep — **deterministic where the answer is objectively calculable, LLM where it requires semantic judgment** — never keyword-matching for either.

---

## Engine A — Preventive/Reminder Tasks (Deterministic, Absence-Triggered)

These are **not** triggered by something alarming being said — they're triggered by something expected *not* having been mentioned, checked against a small, physician-curated guideline table.

### Example guideline table

```
guideline_rules
| id  | applies_if                          | recommendation        | category   |
|-----|--------------------------------------|------------------------|------------|
| g01 | age >= 50                            | shingles_vaccine       | vaccine    |
| g02 | age >= 45                            | colonoscopy_screening  | screening  |
| g03 | sex == 'female' AND age >= 40        | mammogram_screening    | screening  |
| g04 | age >= 65 OR chronic_condition_flag  | pneumococcal_vaccine   | vaccine    |
| g05 | age >= 18 (annual)                   | flu_vaccine            | vaccine    |
| g06 | any (every 10 years)                 | tetanus_booster        | vaccine    |
```

This table is intentionally small and fully physician-readable — per the Bond interview-prep Q29 answer's "narrow but complete" MVP philosophy, this should be a ruleset a physician can review line by line, not an LLM guessing at guidelines.

### Matching logic

```
1. For each rule the patient qualifies for (based on known age/sex, or facts
   captured this session):
   a. Search reconciled health_events for anything confirming the
      recommendation was already done (e.g. subcategory contains
      "shingles_vaccine" with category "medication" or a note the patient
      already had it).
   b. If NOT found → generate a followup_task:
        type: 'vaccine_reminder' | 'screening_reminder'
        category: from the rule
        rationale: "Patient is <criteria>; no record of <recommendation>
                    in captured history."
   c. If found → no task generated (guideline already satisfied).
```

**Worked example (matches the founder demo):** if the patient is 55 and no `health_events` row mentions a shingles vaccine, generate:
```json
{
  "type": "vaccine_reminder",
  "category": "vaccine",
  "urgency": "routine",
  "rationale": "Patient is 55; CDC guidance recommends shingles vaccination at 50+; not mentioned in captured history.",
  "source_rule": "g01"
}
```

---

## Engine B — Referral Tasks (LLM Semantic Classification)

Symptom-type facts ("numbness in wrist", "frequent urination") are **not** run through a fixed keyword list — per the house rule against keyword/regex matching for semantic intent, hard-coding `if 'numbness' in text` would false-positive on irrelevant mentions and miss paraphrases. Instead, every `health_events` row with `category = 'symptom'` is run through a classifier prompt.

### Referral classifier prompt

```
You are assisting a physician-supervised health platform. You will be given one
patient-reported symptom or health item extracted from a conversation transcript,
along with brief context (patient age, when this was mentioned).

Decide whether a physician would typically want to review this directly rather
than let it pass without comment — not whether it's an emergency, just whether
it warrants a follow-up look.

Respond ONLY with this JSON:
{
  "needs_referral": <boolean>,
  "suggested_specialty": "<string or null>",
  "urgency": "routine" | "soon" | "urgent",
  "rationale": "<one sentence, plain language>"
}

Be conservative: if genuinely unsure, prefer needs_referral=true with
urgency="routine" over silently dropping something a physician might want to see.
Never diagnose — only flag for review.
```

### Worked examples (from the founder demo)

**Input:** `{description: "numbness in wrist, comes and goes", approx_age: null, person: "self"}`
```json
{
  "needs_referral": true,
  "suggested_specialty": "primary care or orthopedics",
  "urgency": "routine",
  "rationale": "Intermittent wrist numbness can indicate nerve compression (e.g. carpal tunnel) and typically warrants a physician evaluation."
}
```

**Input:** `{description: "frequent urination, past few weeks", approx_age: null, person: "self"}`
```json
{
  "needs_referral": true,
  "suggested_specialty": "primary care",
  "urgency": "soon",
  "rationale": "New-onset frequent urination can be an early sign of diabetes or a urinary issue and warrants a timely physician review."
}
```

### Always-escalate override

Regardless of the classifier's output, a small **policy allowlist** (not a calibration threshold — see the Q23 human-in-the-loop answer in Bond interview prep) forces `urgency: "urgent"` for anything matching crisis/emergency-pattern language, independent of the LLM's confidence. This is a governance decision, not an ML one, and should sit above this classifier rather than inside it.

---

## Task Data Model

```
followup_tasks
  id
  patient_id
  source_event_id   -- FK to health_events, null for pure guideline-absence tasks
  type              -- 'vaccine_reminder' | 'screening_reminder' | 'referral'
  category
  urgency           -- 'routine' | 'soon' | 'urgent'
  suggested_specialty  -- referral tasks only
  rationale
  source_rule       -- guideline rule id, for reminder tasks
  status            -- 'open' | 'dismissed' | 'completed'
  physician_reviewed -- boolean, false by default for anything Engine B produced
  created_at
```

**Physician review gate:** for anything beyond a founder-demo scope, Engine B's output (referral tasks) should land in a physician review queue before reaching the patient dashboard as a confirmed task — Engine A's guideline reminders are low-risk enough to surface directly, since they're fully deterministic and physician-authored in advance. This mirrors the Theta engine's Do-Nothing/Retrieve-More/Act-Decisively split already in Bond interview prep: Engine A behaves like a pre-approved "Act Decisively" category, Engine B behaves like "Retrieve More" (physician confirms) until enough calibration data justifies loosening that gate.
