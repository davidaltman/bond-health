/**
 * The controlled vocabulary the decision engine queries, and the physician-
 * authored guideline it applies.
 *
 * Facts arrive with a free-text `attribute` the model chose: across runs the
 * same statement produced "colonoscopy", "stool tests", "colon cancer". If the
 * gates matched on those strings directly they would pass in testing and fail
 * intermittently in production, which is the same failure already hit twice in
 * Phase 1 (subject vocabulary, and relative-condition category). Both times the
 * fix was to stop asking the model and decide in code, so that is what happens
 * here: free-text attributes resolve into a small fixed set of slots, and the
 * gates only ever speak in slots.
 *
 * The guideline table below is hardcoded and physician-authored. The model
 * decides which facts are true; it never decides what the medically correct
 * screening age is, and it never writes patient-facing clinical wording.
 */
import type { ClinicalFact, FactStatus } from "./ledger.js";

export type Slot =
  | "colonoscopy_screening"
  | "alternative_screening"
  /** The "has anyone" aggregation used by recommendScreening -- any relative
   *  at all (mother, father, sibling, grandparent, or an unattributed
   *  collective "family" statement), not just the two tracked below. Kept
   *  separate from those two so narrowing who gets individually asked about
   *  never narrows what the risk calculation itself is willing to count. */
  | "colorectal_cancer_family_history"
  /** Individually asked, mirroring the original intake agent's family-history
   *  stage (see agent_configs/03_daphne_family_history.create.json's
   *  metadata.notes) rather than one blanket "any family history?" question
   *  -- that agent's whole incident history is *why* this app moved
   *  checklists into tracked state instead of a model's turn-by-turn
   *  judgment (see README's "watching and improving" section). Scoped to
   *  mother and father only: the guideline table only ever treats a
   *  first-degree relative differently, so siblings/grandparents are out of
   *  scope for asking, same as they were out of scope for the old
   *  four-category version, just drawn at the line this app's guideline
   *  table actually uses. A collective "nobody in my family" answer
   *  satisfies both at once -- see familyHistorySlotsForFact. */
  | "colorectal_cancer_family_history_mother"
  | "colorectal_cancer_family_history_father"
  | "colon_polyps"
  | "rectal_bleeding"
  | "unexplained_weight_loss"
  | "bowel_habit_change"
  | "iron_deficiency_anemia";

/** Slots that mean "this may not be routine screening". */
export const RED_FLAG_SLOTS: Slot[] = [
  "rectal_bleeding",
  "unexplained_weight_loss",
  "bowel_habit_change",
  "iron_deficiency_anemia",
];

interface SlotMatcher {
  slot: Slot;
  /** Whose fact this can be. Keeps "my father had colon cancer" out of the
   *  patient's own condition slots. */
  subject: "self" | "relative";
  pattern: RegExp;
}

/**
 * Colon-cancer/polyps family history is handled separately by
 * familyHistorySlotsForFact below, not through this generic table, because
 * one fact needs to be able to fan out into more than one slot (a collective
 * "nobody in my family" answers for both mother and father at once) --
 * something a one-fact-one-slot matcher can't express.
 *
 * Bare "polyp[s]" is included, not just "colon polyp": the model records the
 * attribute exactly as the patient said it ("my mom had polyps" -> attribute
 * "polyps", no "colon" prefix), and a stricter phrase match here silently
 * dropped that fact from the decision engine entirely -- it stayed correctly
 * on the ledger, but nothing here matched it, so the family-history slots
 * kept reading as unmentioned and the same question looped forever.
 */
const FAMILY_HISTORY_PATTERN = /colon cancer|colorectal|bowel cancer|rectal cancer|colon polyp|\bpolyps?\b/i;

const SLOT_MATCHERS: SlotMatcher[] = [
  { slot: "colonoscopy_screening", subject: "self", pattern: /colonoscop|colon scope|sigmoidoscop/i },
  {
    slot: "alternative_screening",
    subject: "self",
    pattern: /stool test|stool sample|fit test|\bfit\b|cologuard|fecal|occult blood|\bfobt\b/i,
  },
  { slot: "colon_polyps", subject: "self", pattern: /polyp/i },
  {
    slot: "rectal_bleeding",
    subject: "self",
    pattern: /rectal bleed|blood in (the |my )?stool|bloody stool|blood when|hematochezia|bleeding from/i,
  },
  {
    slot: "unexplained_weight_loss",
    subject: "self",
    pattern: /weight loss|losing weight|lost weight|dropped weight/i,
  },
  {
    slot: "bowel_habit_change",
    subject: "self",
    pattern: /bowel habit|change in (my )?bowel|constipat|diarrh|narrow stool|stool.*(chang|thin)/i,
  },
  { slot: "iron_deficiency_anemia", subject: "self", pattern: /anemi|anaemi|iron deficien|low iron/i },
];

/**
 * Fans a relative's colon-cancer/polyps fact out into every slot it answers.
 * Unlike the generic SLOT_MATCHERS table (one fact, one slot), this can
 * return more than one: `fact.subject` arrives already canonicalized by
 * ledger.ts (see canonicalSubject/inferFamilyScope), so "mother"/"father" hit
 * their own tracked slot, and an unattributed collective "family" statement
 * -- "nobody in my family has had that" -- answers both at once, exactly as
 * it would if a person had actually asked both questions and gotten the same
 * answer twice. Always also contributes to the generic aggregation slot, so
 * a sibling's or grandparent's history (not individually asked about, but
 * still a real first-degree-adjacent signal) still reaches the guideline
 * calculation even though it satisfies neither tracked question.
 */
function familyHistorySlotsForFact(fact: ClinicalFact): Slot[] {
  if (fact.subject === "self") return [];
  if (!FAMILY_HISTORY_PATTERN.test(`${fact.attribute} ${fact.value}`)) return [];
  const slots: Slot[] = ["colorectal_cancer_family_history"];
  if (fact.subject === "mother" || fact.subject === "family") slots.push("colorectal_cancer_family_history_mother");
  if (fact.subject === "father" || fact.subject === "family") slots.push("colorectal_cancer_family_history_father");
  return slots;
}

/** Every slot a fact fills. Almost always at most one -- see
 *  familyHistorySlotsForFact for the one case where a single fact answers
 *  more than one tracked question at once. */
export function slotsForFact(fact: ClinicalFact): Slot[] {
  const familySlots = familyHistorySlotsForFact(fact);
  if (familySlots.length > 0) return familySlots;

  const haystack = `${fact.attribute} ${fact.value}`;
  const isSelf = fact.subject === "self";
  for (const matcher of SLOT_MATCHERS) {
    if (matcher.subject === "self" && !isSelf) continue;
    if (matcher.subject === "relative" && isSelf) continue;
    if (matcher.pattern.test(haystack)) return [matcher.slot];
  }
  return [];
}

export interface SlotReading {
  slot: Slot;
  /** null means the topic has never come up. Crucially different from a fact
   *  with status "never", which means the patient answered no. */
  status: FactStatus | null;
  facts: ClinicalFact[];
}

const RELATIVE_SLOTS = new Set<Slot>([
  "colorectal_cancer_family_history",
  "colorectal_cancer_family_history_mother",
  "colorectal_cancer_family_history_father",
  ...SLOT_MATCHERS.filter((matcher) => matcher.subject === "relative").map((matcher) => matcher.slot),
]);

/**
 * Collapses every fact filed under a slot into the one status the gates see.
 *
 * The three branches encode three different, deliberately non-interchangeable
 * merge rules -- getting this wrong is how the family-history bug shipped:
 * an earlier "sharpen unknown only" rule (correct for a patient's own binary
 * history) was silently applied to relative facts too, which meant a
 * collective denial ("nobody in my family has...") permanently blocked a
 * later, more specific, more informative fact ("my mom had polyps") from
 * ever being seen -- the fact sat correctly on the ledger the whole time; the
 * gates just never looked at it again.
 */
function aggregateStatus(slot: Slot, facts: ClinicalFact[]): FactStatus | null {
  if (facts.length === 0) return null;

  if (RED_FLAG_SLOTS.includes(slot)) {
    // A current symptom is a one-way ratchet: once any fact says "active", no
    // earlier or later denial clears it. Not last-write-wins on purpose --
    // for a safety question, missing a real symptom is the only error that
    // matters here.
    return facts.some((f) => f.qualifiers.status === "active") ? "active" : facts[facts.length - 1].qualifiers.status;
  }

  if (RELATIVE_SLOTS.has(slot)) {
    // Family history is a "has anyone" aggregation, not one person's
    // timeline, and per isAffirmative()'s own contract a relative fact is
    // affirmative at *any* status except "never" -- "unknown" still means it
    // happened, just without detail on whether it's ongoing. So any non-never
    // fact here outranks a separate "never" fact, even one for a different
    // condition or a different (collective "family") subject: "nobody in my
    // family has had that" and "my mom had polyps" cannot both be true, and
    // the finding is the one that changes the screening age. Only when every
    // fact under this slot is a "never" does the slot read as "never".
    if (facts.some((f) => f.qualifiers.status !== "never")) {
      if (facts.some((f) => f.qualifiers.status === "active")) return "active";
      if (facts.some((f) => f.qualifiers.status === "resolved")) return "resolved";
      return "unknown";
    }
    return "never";
  }

  // Self-reported history: only ever sharpen an unanswered slot. A later
  // vague fact must not overwrite a definite one -- "patient asked to book a
  // colonoscopy" arriving as active would otherwise flip "never screened" to
  // "screened", which is the most dangerous single error this engine could
  // make. The first definite fact wins, permanently.
  const definite = facts.find((f) => f.qualifiers.status !== "unknown");
  return definite ? definite.qualifiers.status : "unknown";
}

export function readSlots(facts: ClinicalFact[]): Map<Slot, SlotReading> {
  const bucketed = new Map<Slot, ClinicalFact[]>();
  for (const fact of facts) {
    for (const slot of slotsForFact(fact)) {
      const list = bucketed.get(slot);
      if (list) list.push(fact);
      else bucketed.set(slot, [fact]);
    }
  }

  const readings = new Map<Slot, SlotReading>();
  for (const [slot, slotFacts] of bucketed) {
    readings.set(slot, { slot, status: aggregateStatus(slot, slotFacts), facts: slotFacts });
  }
  return readings;
}

export function readSlot(readings: Map<Slot, SlotReading>, slot: Slot): SlotReading {
  return readings.get(slot) ?? { slot, status: null, facts: [] };
}

/**
 * The topic has come up at all.
 *
 * Weaker than it sounds: a fact can exist with status "unknown", which means
 * the subject was mentioned but not answered ("my doctor keeps bringing up a
 * colonoscopy" creates a colonoscopy fact that tells us nothing about whether
 * she's had one).
 */
export function isMentioned(reading: SlotReading): boolean {
  return reading.status !== null;
}

/**
 * The patient actually answered.
 *
 * This is the gate-relevant one, and it is the Phase 1 never-vs-absent
 * distinction applied one layer up. "Never had one" is an answer; "we talked
 * around it" is not. Treating status "unknown" as knowledge is what let an
 * earlier build book a colonoscopy for someone whose screening history it had
 * never actually established.
 */
export function isAnswered(reading: SlotReading): boolean {
  return reading.status === "active" || reading.status === "resolved" || reading.status === "never";
}

/** True when a finding is present, as opposed to known-absent or unasked. */
export function isPresent(reading: SlotReading): boolean {
  return reading.status === "active" || reading.status === "resolved";
}

/**
 * For history about someone else, the fact existing *is* the finding.
 *
 * `status` on a relative's condition describes their course, not whether it
 * happened -- "my father had colon cancer" often lands as status "unknown"
 * because nobody said whether he still has it. Requiring `active` there would
 * silently drop the family history that changes the screening age. Only an
 * explicit "nobody in my family" (status "never") means absent.
 */
export function isAffirmative(reading: SlotReading): boolean {
  return reading.status !== null && reading.status !== "never";
}

// ---------------------------------------------------------------------------
// Guideline. Hardcoded on purpose.
// ---------------------------------------------------------------------------

/**
 * Colorectal cancer screening thresholds, following USPSTF/ACS-style guidance:
 * average risk begins at 45; a first-degree relative with colorectal cancer
 * moves the start to age 40, or ten years before that relative's diagnosis,
 * whichever comes first.
 *
 * This is a demo table, not a clinical product. It is hardcoded rather than
 * generated so the recommendation is reproducible and reviewable -- a model
 * that re-derives the start age each call will eventually derive it wrong.
 */
export const SCREENING_GUIDELINE = {
  averageRiskStartAge: 45,
  familyHistoryFloorAge: 40,
  familyHistoryLeadYears: 10,
  /** Interval for a normal average-risk result. Used in patient-facing copy. */
  averageRiskIntervalYears: 10,
  familyHistoryIntervalYears: 5,
} as const;

/**
 * How soon this should land, as a function of how overdue the patient is.
 *
 * Someone two years past their start age and someone twenty years past are not
 * the same clinical problem, and collapsing them into one "book sometime"
 * window is how a scheduler ends up looking competent while quietly deferring
 * the person who needed it most. The tightest tier is deliberately shorter than
 * the mock clinic's lead time, so the waitlist path is reachable by a real
 * patient profile rather than by a failure injection.
 */
function bookingWindowDays(yearsOverdue: number, elevatedRisk: boolean): number {
  if (yearsOverdue >= 15 && elevatedRisk) return 14;
  if (yearsOverdue >= 5) return 30;
  return 90;
}

export interface ScreeningRecommendation {
  indicated: boolean;
  startAge: number;
  intervalYears: number;
  riskTier: "average" | "elevated_family_history";
  /** How urgently this should land, which is what makes the scheduler's
   *  unhappy path reachable. */
  bookWithinDays: number;
  /** For the decision log and the review pane. Precise, clinician-facing. */
  rationale: string;
  /**
   * For the patient. Kept separate because the two audiences need different
   * sentences and the first draft of this proved it: "First-degree relative
   * diagnosed at 52: screening begins at 40 (10 years earlier, floored at 40)"
   * is exactly right in a decision log and unusable out loud. Authored here so
   * a model never has to translate between them.
   */
  patientSummary: string;
}

export function recommendScreening(
  patientAge: number,
  familyHistory: SlotReading,
): ScreeningRecommendation {
  const hasFamilyHistory = isAffirmative(familyHistory);
  if (!hasFamilyHistory) {
    return {
      indicated: patientAge >= SCREENING_GUIDELINE.averageRiskStartAge,
      startAge: SCREENING_GUIDELINE.averageRiskStartAge,
      intervalYears: SCREENING_GUIDELINE.averageRiskIntervalYears,
      riskTier: "average",
      bookWithinDays: bookingWindowDays(patientAge - SCREENING_GUIDELINE.averageRiskStartAge, false),
      rationale: `Average risk: screening begins at ${SCREENING_GUIDELINE.averageRiskStartAge}.`,
      patientSummary: `Screening is recommended for everyone from ${SCREENING_GUIDELINE.averageRiskStartAge}, so you're due.`,
    };
  }

  // Ten years before the relative's diagnosis, floored at 40.
  const relativeAges = familyHistory.facts
    .map((fact) => fact.qualifiers.onsetAge)
    .filter((age): age is number => typeof age === "number");
  const earliestDiagnosis = relativeAges.length ? Math.min(...relativeAges) : null;
  const leadAge =
    earliestDiagnosis != null ? earliestDiagnosis - SCREENING_GUIDELINE.familyHistoryLeadYears : null;
  const startAge =
    leadAge != null
      ? Math.min(SCREENING_GUIDELINE.familyHistoryFloorAge, leadAge)
      : SCREENING_GUIDELINE.familyHistoryFloorAge;

  const rationale =
    earliestDiagnosis != null
      ? `First-degree relative diagnosed at ${earliestDiagnosis}: screening begins at ${startAge} ` +
        `(${SCREENING_GUIDELINE.familyHistoryLeadYears} years earlier, floored at ${SCREENING_GUIDELINE.familyHistoryFloorAge}).`
      : `Family history of colorectal cancer: screening begins at ${SCREENING_GUIDELINE.familyHistoryFloorAge}.`;

  return {
    indicated: patientAge >= startAge,
    startAge,
    intervalYears: SCREENING_GUIDELINE.familyHistoryIntervalYears,
    riskTier: "elevated_family_history",
    bookWithinDays: bookingWindowDays(patientAge - startAge, true),
    rationale,
    patientSummary:
      `Because of your family history, screening starts earlier for you — at ${startAge} rather than ` +
      `${SCREENING_GUIDELINE.averageRiskStartAge} — so you're due.`,
  };
}

/** Red flags the patient currently has. Any one of these means this is not a
 *  routine screening question anymore. */
export function activeRedFlags(readings: Map<Slot, SlotReading>): SlotReading[] {
  return RED_FLAG_SLOTS.map((slot) => readSlot(readings, slot)).filter(
    (reading) => reading.status === "active",
  );
}

/**
 * Whether symptoms have been addressed at all.
 *
 * Satisfied by an answer to *any* red flag, not all of them. Requiring each one
 * separately would turn this into the intake questionnaire the brief explicitly
 * argues against: one "any bleeding, weight loss, or changes in bowel habits?"
 * covers the family, and the answer -- yes or no -- makes the topic known.
 */
export function redFlagsAddressed(readings: Map<Slot, SlotReading>): boolean {
  return RED_FLAG_SLOTS.some((slot) => isAnswered(readSlot(readings, slot)));
}

export const RED_FLAG_QUESTION =
  "Before I set anything up — any bleeding, unexplained weight loss, or changes in your bowel habits?";

/**
 * What must be known before a screening colonoscopy can be booked.
 *
 * Deliberately short. The brief asks for the fewest steps to resolution, so
 * this is the minimum set that changes the decision, not an intake form.
 * Ordered by value, which is the order ASK will walk.
 */
export interface Requirement {
  slot: Slot;
  question: string;
  why: string;
  /**
   * `answer` — the patient must have actually said yes or no.
   * `mention` — the topic existing is enough, because for family history the
   * fact's presence is the finding and its status describes the relative.
   */
  satisfiedBy: "answer" | "mention";
}

export const REQUIRED_SLOTS: Requirement[] = [
  {
    slot: "colonoscopy_screening",
    question: "Have you ever had a colonoscopy before?",
    why: "Prior screening determines whether anything is due at all.",
    satisfiedBy: "answer",
  },
  // Asked individually -- mother, then father -- rather than one blanket
  // "any family history?" question. See the Slot type's comment on these two
  // for why: the original intake agent tried the blanket version, model-side,
  // and repeatedly short-circuited after one relative's finding (see
  // agent_configs/03_daphne_family_history.create.json's metadata.notes). A
  // collective "nobody in my family has had that" still satisfies both at
  // once -- see familyHistorySlotsForFact -- so a patient who answers that
  // way is never asked twice for the same information.
  {
    slot: "colorectal_cancer_family_history_mother",
    question: "Has your mother had colon cancer or polyps?",
    why: "A first-degree relative moves the start age and shortens the interval.",
    satisfiedBy: "mention",
  },
  {
    slot: "colorectal_cancer_family_history_father",
    question: "And has your father had colon cancer or polyps?",
    why: "A first-degree relative moves the start age and shortens the interval.",
    satisfiedBy: "mention",
  },
];

export function isSatisfied(requirement: Requirement, reading: SlotReading): boolean {
  return requirement.satisfiedBy === "answer" ? isAnswered(reading) : isMentioned(reading);
}
