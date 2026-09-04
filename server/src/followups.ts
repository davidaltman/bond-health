/**
 * Post-extraction insights & actions pass -- turns reconciled `health_events`
 * (see timeline.ts / extraction/timeline_extraction_prompt.md) into a short,
 * priority-sorted list for the patient dashboard.
 *
 * Implements extraction/followup_task_rules.md's Engine A (deterministic
 * guideline reminders) plus a semantic pattern pass covering that doc's
 * Engine B (symptom referral) and a new Engine C (familial clustering,
 * added while building this feature -- see the "Corrections found while
 * verifying this plan" notes in the design chat this shipped from).
 *
 * Deliberate design choice: the LLM only classifies (which people, which
 * pattern type, which specialty) -- it never writes the action/who/when
 * copy shown to the patient. That copy comes from the physician-authored
 * tables below (GUIDELINE_RULES, PATTERN_TEMPLATES). This mirrors the
 * project's existing rule against letting a conversational or extraction
 * model make clinical judgment calls; the same discipline applies here.
 *
 * NOTE: the action copy in GUIDELINE_RULES / PATTERN_TEMPLATES is demo
 * placeholder text, not physician-reviewed. Treat it the same way as the
 * example guideline_rules table in followup_task_rules.md -- a stand-in for
 * what a real clinical content review would produce, not the real thing.
 */
import { completeJson } from "./llm.js";
import type { HealthEvent } from "./timeline.js";

export type FollowUpWhen = "few_weeks" | "next_visit" | "no_visit" | "next_call";

export interface FollowUpItem {
  finding: string;
  action: string;
  who: string;
  when: FollowUpWhen;
  sources: string;
  authoredBy: "guideline_table" | "pattern_template" | "deterministic_check";
}

// This pass makes judgment calls across several people's records (clustering,
// referral triage), so it gets its own model knob and a higher reasoning
// effort than timeline.ts's straightforward extraction. On Bedrock this was a
// deliberately stronger model with extended thinking enabled; the OpenAI
// equivalent is the same model at a higher reasoning_effort.
const FOLLOWUPS_MODEL = process.env.FOLLOWUPS_OPENAI_MODEL || process.env.OPENAI_MODEL || "gpt-5.4-mini";

export const WHEN_ORDER: FollowUpWhen[] = ["few_weeks", "next_visit", "no_visit", "next_call"];
const MAX_ITEMS = 8;

// ---------------------------------------------------------------------------
// Engine A -- deterministic, physician-authored guideline table. Kept small
// and readable line by line, same "narrow but complete" philosophy as the
// example table in followup_task_rules.md.
// ---------------------------------------------------------------------------

interface GuidelineRule {
  id: "g01" | "g02";
  appliesIf: (age: number) => boolean;
  finding: (age: number) => string;
  action: string;
  who: string;
  when: FollowUpWhen;
}

const GUIDELINE_RULES: GuidelineRule[] = [
  {
    id: "g01",
    appliesIf: (age) => age >= 50,
    finding: (age) => `No shingles vaccination mentioned (age ${age})`,
    action: "Ask about the two-dose shingles vaccine -- most pharmacies give it without a doctor visit.",
    who: "Pharmacy or primary care",
    when: "next_visit",
  },
  {
    id: "g02",
    appliesIf: (age) => age >= 45,
    finding: (age) => `No colorectal screening mentioned (age ${age})`,
    action: "Book a colonoscopy, or ask about a stool-based test if you prefer.",
    who: "Primary care",
    when: "few_weeks",
  },
];

// ---------------------------------------------------------------------------
// Engine C -- familial cluster / early-death pattern templates. The LLM pass
// below only ever returns one of these keys; it does not write the action
// text itself.
// ---------------------------------------------------------------------------

type PatternType =
  | "familial_cluster_early"
  | "familial_cluster_late"
  | "familial_cluster_confounded"
  | "familial_mechanical"
  | "family_early_death";

const PATTERN_TYPES: PatternType[] = [
  "familial_cluster_early",
  "familial_cluster_late",
  "familial_cluster_confounded",
  "familial_mechanical",
  "family_early_death",
];

const PATTERN_TEMPLATES: Record<PatternType, { action: string; who: string; when: FollowUpWhen }> = {
  familial_cluster_early: {
    action: "Worth discussing with your primary care provider, including whether a specialist referral makes sense.",
    who: "Primary care",
    when: "next_visit",
  },
  familial_cluster_late: {
    action: "Worth recording in your family history. At this age, this pattern alone doesn't typically call for additional testing.",
    who: "No visit needed",
    when: "no_visit",
  },
  familial_cluster_confounded: {
    action: "Noting this for your record -- a stated cause may explain it independent of family history.",
    who: "No visit needed",
    when: "no_visit",
  },
  familial_mechanical: {
    action: "No screening exists for this. Worth knowing the pattern so new symptoms get evaluated promptly.",
    who: "Primary care if symptoms appear",
    when: "no_visit",
  },
  family_early_death: {
    action: "Worth mentioning at your next visit, including a review of relevant vaccinations.",
    who: "Primary care",
    when: "next_visit",
  },
};

// Engine B (existing design, extraction/followup_task_rules.md) -- referral
// urgency mapped onto the same when-axis everything else uses.
const URGENCY_TO_WHEN: Record<"routine" | "soon" | "urgent", FollowUpWhen> = {
  urgent: "few_weeks",
  soon: "few_weeks",
  routine: "next_visit",
};

// ---------------------------------------------------------------------------
// Single model pass: classification only (which people, which pattern,
// which specialty, which guideline is already satisfied). See file header
// for why action copy is not part of this model's job.
// ---------------------------------------------------------------------------

const PATTERN_SYSTEM_PROMPT = `You are a clinical-pattern reviewer for a physician-supervised health platform.
You will be given a patient's captured health history as a JSON array of
health_events (already extracted from a conversation -- treat every entry as
a fact the patient stated) and the patient's current age.

Cite only what is present in the health_events you were given. Never invent a
fact, a statistic, or a diagnosis, and never suggest a specific medical
action yourself -- that comes from a separate physician-authored table. Your
job is classification only, in four parts.

1. GUIDELINE CONFIRMATIONS
   For each guideline id below, decide semantically (not by keyword match)
   whether the health_events already show the patient has done it --
   "got my shingles shot last year" counts; "my mother had shingles" does
   not.
     g01: patient has already been vaccinated for shingles
     g02: patient has already had a colonoscopy or other colorectal
          screening
   Default to false when unclear.

2. FAMILIAL CLUSTERS
   Look for the same or closely related condition appearing in two or more
   DISTINCT people (the patient counts as one). Use the free-text
   description to tell people apart even when rows share the same "person"
   label (e.g. two rows both labeled "sibling" can be two different
   individuals -- read the description, don't assume). For each real cluster,
   classify it as exactly one pattern_type:
     familial_cluster_early      onset/diagnosis under age 50 for the people
                                  involved
     familial_cluster_late       onset/diagnosis at age 70+, plausibly
                                  age-related rather than hereditary
     familial_cluster_confounded a stated external cause (e.g. smoking)
                                  plausibly explains it independent of
                                  family history
     familial_mechanical         a structural/surgical condition (e.g.
                                  hernia repair), not a hereditary disease
                                  risk
   Never build a cluster from a single person or from a healthy/negative
   finding (e.g. "sister is healthy", "lived to 102 in good health").

3. FAMILY EARLY DEATH -- MANDATORY, do not apply clinical judgment here
   Scan every relative event's description for a stated death (words like
   "died", "fatal", "passed away", "deceased"). This check is REQUIRED even
   when the cause looks acute, accidental, or non-hereditary (e.g. a sudden
   infection, an accident, a heart attack) -- early death in a first- or
   second-degree relative is worth flagging regardless of mechanism, and it
   is not your job to decide the cause is unrelated. If the stated age at
   death is 50 or under, add an entry to the clusters list with
   pattern_type "family_early_death" and a single-element people list
   containing just that relative -- this is the one exception to "never
   build a cluster from a single person" in part 2, because this pattern
   type is a per-person flag, not a multi-person cluster. Do this even if
   the same relative already appears with a different pattern_type in
   another clusters entry.
   Example: a health_event reads "sibling -- car accident, fatal --
   approx_age 29" -> this MUST produce a clusters entry
   {"pattern_type": "family_early_death", "people": ["sibling"], ...}, even
   though a car accident has no hereditary component.

4. SYMPTOM REFERRALS
   For every health_event with category "symptom", decide whether a
   physician would typically want to review it directly (not whether it's
   an emergency). Be conservative -- if genuinely unsure, flag it.

5. DATA GAPS
   Flag any event where a clearly relevant detail was left unknown or
   unspecified by the patient (e.g. "dose unknown").

Output ONLY the JSON object matching the schema you were given. No prose.`;

const PATTERN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    guideline_confirmations: {
      type: "object",
      additionalProperties: false,
      properties: {
        g01: { type: "boolean" },
        g02: { type: "boolean" },
      },
      required: ["g01", "g02"],
    },
    clusters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          pattern_type: { type: "string", enum: PATTERN_TYPES },
          people: { type: "array", items: { type: "string" } },
          finding: { type: "string" },
          confounder: { type: ["string", "null"] },
        },
        required: ["pattern_type", "people", "finding", "confounder"],
      },
    },
    symptom_referrals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          person: { type: "string" },
          description: { type: "string" },
          suggested_specialty: { type: "string" },
          urgency: { type: "string", enum: ["routine", "soon", "urgent"] },
        },
        required: ["person", "description", "suggested_specialty", "urgency"],
      },
    },
    data_gaps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          person: { type: "string" },
          description: { type: "string" },
          missing_field: { type: "string" },
        },
        required: ["person", "description", "missing_field"],
      },
    },
  },
  required: ["guideline_confirmations", "clusters", "symptom_referrals", "data_gaps"],
};

interface PatternExtractionResult {
  guideline_confirmations: { g01: boolean; g02: boolean };
  clusters: Array<{
    pattern_type: PatternType;
    people: string[];
    finding: string;
    confounder: string | null;
  }>;
  symptom_referrals: Array<{
    person: string;
    description: string;
    suggested_specialty: string;
    urgency: "routine" | "soon" | "urgent";
  }>;
  data_gaps: Array<{ person: string; description: string; missing_field: string }>;
}

async function runPatternExtraction(events: HealthEvent[], age: number | null): Promise<PatternExtractionResult> {
  const userPrompt = [
    `Patient age: ${age != null ? age : "unknown"}`,
    "",
    "health_events:",
    JSON.stringify(events, null, 2),
    "",
    "Return strict JSON matching the schema you were given.",
  ].join("\n");

  return completeJson<PatternExtractionResult>({
    system: PATTERN_SYSTEM_PROMPT,
    user: userPrompt,
    schemaName: "pattern_extraction",
    schema: PATTERN_JSON_SCHEMA,
    model: FOLLOWUPS_MODEL,
    maxOutputTokens: 8192,
    reasoningEffort: "medium",
  });
}

// ---------------------------------------------------------------------------
// Deterministic check: is the age entered in the UI younger than an age the
// patient already stated for themself on this call? Pure arithmetic on
// approx_age -- no semantic judgment involved, so no LLM call needed.
// ---------------------------------------------------------------------------

function ageFloorCheck(events: HealthEvent[], enteredAge: number): FollowUpItem | null {
  const selfAges = events
    .filter((event) => event.person.trim().toLowerCase() === "self" && event.approx_age != null)
    .map((event) => event.approx_age as number);
  if (selfAges.length === 0) return null;
  const maxSelfAge = Math.max(...selfAges);
  if (enteredAge >= maxSelfAge) return null;
  return {
    finding: `Entered age (${enteredAge}) is younger than an age already stated on this call (${maxSelfAge})`,
    action: "Double check the age entered above -- it may need updating to match what was said on the call.",
    who: "Intake only",
    when: "next_call",
    sources: "Your stated history",
    authoredBy: "deterministic_check",
  };
}

function formatPeople(people: string[]): string {
  const cleaned = people.map((person) => person.trim()).filter(Boolean);
  const unique = [...new Set(cleaned)];
  return unique.length ? unique.join(", ") : "captured history";
}

export async function generateFollowUps(events: HealthEvent[], age: number | null): Promise<FollowUpItem[]> {
  let extraction: PatternExtractionResult | null = null;
  try {
    extraction = await runPatternExtraction(events, age);
  } catch (error) {
    // A failed pattern pass should not take down the whole /api/summarize
    // response -- deterministic items below still generate on their own.
    // eslint-disable-next-line no-console
    console.error("Follow-up pattern extraction failed; continuing with deterministic items only:", error);
  }

  const items: FollowUpItem[] = [];

  if (age != null) {
    for (const rule of GUIDELINE_RULES) {
      if (!rule.appliesIf(age)) continue;
      const alreadyConfirmed = extraction?.guideline_confirmations[rule.id] ?? false;
      if (alreadyConfirmed) continue;
      items.push({
        finding: rule.finding(age),
        action: rule.action,
        who: rule.who,
        when: rule.when,
        sources: `Age ${age} vs. guideline ${rule.id}`,
        authoredBy: "guideline_table",
      });
    }

    const ageConflict = ageFloorCheck(events, age);
    if (ageConflict) items.push(ageConflict);
  }

  if (extraction) {
    for (const cluster of extraction.clusters) {
      const template = PATTERN_TEMPLATES[cluster.pattern_type];
      if (!template) continue; // model returned something outside the enum -- drop rather than guess
      items.push({
        finding: cluster.finding,
        action: cluster.confounder ? `${template.action} (Possible explanation: ${cluster.confounder}.)` : template.action,
        who: template.who,
        when: template.when,
        sources: formatPeople(cluster.people),
        authoredBy: "pattern_template",
      });
    }

    for (const referral of extraction.symptom_referrals) {
      items.push({
        finding: `${referral.description}${referral.person !== "self" ? ` (${referral.person})` : ""}`,
        action: "Worth a look with a physician -- not necessarily urgent, but worth mentioning.",
        who: referral.suggested_specialty || "Primary care",
        when: URGENCY_TO_WHEN[referral.urgency],
        sources: referral.person,
        authoredBy: "pattern_template",
      });
    }

    for (const gap of extraction.data_gaps) {
      items.push({
        finding: `${gap.description} -- ${gap.missing_field} not captured`,
        action: `Share the ${gap.missing_field} next time you talk with Daphne.`,
        who: "Intake only",
        when: "next_call",
        sources: gap.person,
        authoredBy: "deterministic_check",
      });
    }
  }

  items.sort((a, b) => WHEN_ORDER.indexOf(a.when) - WHEN_ORDER.indexOf(b.when));
  return items.slice(0, MAX_ITEMS);
}
