/**
 * The decision engine: every turn resolves to exactly one of four outcomes.
 *
 *   ACT      preconditions met and the patient asked -> do it, return proof
 *   ASK      one decision-relevant thing is missing -> ask for that, only that
 *   STOP     outside what this agent may answer -> say so plainly
 *   HANDOFF  red flag or real ambiguity -> route to a human, don't improvise
 *
 * Two properties this file is built around.
 *
 * First, the gates run in a fixed order and the first one to fire wins, so the
 * outcome is a function of state rather than of how the model felt about the
 * turn. Order encodes priority: a red flag outranks a booking request, and
 * scope outranks everything, because being asked nicely is not a reason to
 * start diagnosing.
 *
 * Second, every decision records which gate fired, why, and which facts it
 * consulted. That log is the "knows what it doesn't know" evidence, and it is
 * what the eval suite asserts against -- decisions get hard assertions, prose
 * gets a soft rubric, and only the first kind can gate a change.
 *
 * Patient-facing wording for clinical recommendations comes from the tables in
 * requirements.ts, never from a model. The model classifies; authored copy
 * speaks.
 */
import type { ClinicalFact, ConversationSignals } from "./ledger.js";
import {
  RED_FLAG_QUESTION,
  REQUIRED_SLOTS,
  activeRedFlags,
  isSatisfied,
  readSlot,
  readSlots,
  recommendScreening,
  redFlagsAddressed,
  type ScreeningRecommendation,
  type Slot,
} from "./requirements.js";

export type Outcome = "ACT" | "ASK" | "STOP" | "HANDOFF";

export type GateName =
  | "scope"
  | "safety"
  | "sufficiency"
  | "readiness"
  | "eligibility"
  | "already_resolved"
  | "stuck"
  | "act";

/**
 * How many times the engine may ask for the same thing before giving up on it.
 *
 * Without this the agent loops: extraction misses the patient's answer, the
 * slot stays unsatisfied, and the same question comes back every turn. That is
 * the exact failure documented in this repo's prior art, where Daphne re-asked
 * questions she had already asked. A ceiling turns a silent loop into an honest
 * HANDOFF -- which is also the more useful behavior, since a question that
 * can't be answered in three tries usually needs a person.
 */
const MAX_ASKS_PER_SLOT = 3;

export interface Decision {
  turn: number;
  outcome: Outcome;
  /** The gate that determined the outcome. */
  gate: GateName;
  reason: string;
  /** For ASK: the one thing being asked for, and the authored wording. */
  missingSlot: Slot | "red_flag_symptoms" | "readiness" | null;
  say: string;
  /** Fact ids consulted, so a reviewer can see the basis rather than trust it. */
  evidence: string[];
  recommendation: ScreeningRecommendation | null;
}

export interface DecisionInput {
  turn: number;
  patientAge: number | null;
  facts: ClinicalFact[];
  signals: ConversationSignals | null;
  /** Set once a booking exists, so the engine stops trying to book again. */
  alreadyBooked: boolean;
  /** How many times each slot has already been asked for in this session. */
  askCounts: Record<string, number>;
}

export function decide(input: DecisionInput): Decision {
  const { turn, facts, signals } = input;
  const readings = readSlots(facts);
  const base = { turn, evidence: facts.map((fact) => fact.id), recommendation: null };

  const exhausted = (slot: string) => (input.askCounts[slot] ?? 0) >= MAX_ASKS_PER_SLOT;
  const giveUp = (slot: string, what: string): Decision => ({
    ...base,
    outcome: "HANDOFF",
    gate: "stuck",
    reason: `Asked for ${slot} ${input.askCounts[slot] ?? 0} times without resolving it. Looping is worse than escalating.`,
    missingSlot: null,
    say:
      `I'm not managing to pin down ${what}, and I don't want to guess at something that matters. ` +
      `Let me put you in front of someone on the care team who can sort it out with you.`,
  });

  // --- Gate 1: scope -------------------------------------------------------
  // Runs first and unconditionally. A request for diagnosis or dosing is out of
  // bounds no matter how complete the record is or how ready the patient is.
  if (signals?.requestType === "clinical_judgment") {
    return {
      ...base,
      outcome: "STOP",
      gate: "scope",
      reason: "Patient asked for clinical judgement (diagnosis, interpretation, or dosing).",
      missingSlot: null,
      say:
        "That's a question for a clinician rather than me — I can't give medical advice or " +
        "interpret symptoms. I can get it in front of your care team, or help you book a visit.",
    };
  }

  // --- Gate 2: safety ------------------------------------------------------
  // Before sufficiency, because a red flag is decisive even when the record is
  // incomplete and the patient never asked for anything.
  const redFlags = activeRedFlags(readings);
  if (redFlags.length > 0) {
    const flagged = redFlags.flatMap((reading) => reading.facts);
    return {
      ...base,
      outcome: "HANDOFF",
      gate: "safety",
      reason: `Active red flag(s): ${redFlags.map((reading) => reading.slot).join(", ")}. Symptomatic presentation is not routine screening.`,
      missingSlot: null,
      evidence: flagged.map((fact) => fact.id),
      say:
        "Thanks for telling me that — what you're describing needs a clinician to look at " +
        "properly, and it's a different conversation from routine screening. I'm passing this " +
        "to your care team so someone can follow up with you directly.",
    };
  }

  if (input.alreadyBooked) {
    return {
      ...base,
      outcome: "ASK",
      gate: "already_resolved",
      reason: "Screening is already booked for this session.",
      missingSlot: null,
      say: "You're all set for the colonoscopy. Anything else I can help with?",
    };
  }

  // --- Gate 3: sufficiency -------------------------------------------------
  // Asks for the single highest-value missing item. Not a questionnaire: the
  // required set is short by design, and this returns after the first gap.
  for (const requirement of REQUIRED_SLOTS) {
    const reading = readSlot(readings, requirement.slot);
    if (isSatisfied(requirement, reading)) continue;
    if (exhausted(requirement.slot)) return giveUp(requirement.slot, "your screening history");
    return {
      ...base,
      outcome: "ASK",
      gate: "sufficiency",
      reason: `Missing ${requirement.slot}. ${requirement.why}`,
      missingSlot: requirement.slot,
      say: requirement.question,
    };
  }

  if (input.patientAge == null) {
    return {
      ...base,
      outcome: "ASK",
      gate: "sufficiency",
      reason: "Age is unknown and determines whether screening is indicated at all.",
      missingSlot: null,
      say: "How old are you?",
    };
  }

  // --- Gate 4: eligibility -------------------------------------------------
  // The guideline table decides this, not the model.
  const familyHistory = readSlot(readings, "colorectal_cancer_family_history");
  const recommendation = recommendScreening(input.patientAge, familyHistory);
  const withRecommendation = { ...base, recommendation };

  if (!recommendation.indicated) {
    return {
      ...withRecommendation,
      outcome: "ASK",
      gate: "eligibility",
      reason: `Not yet indicated: age ${input.patientAge} is below the start age of ${recommendation.startAge}. ${recommendation.rationale}`,
      missingSlot: null,
      say:
        `Based on what you've told me, routine screening starts at ${recommendation.startAge} for you, ` +
        `so there's nothing due yet. Would you like me to note a reminder for then?`,
    };
  }

  // Symptoms get checked once, only at the point where a booking is otherwise
  // possible. Asking earlier would be an interrogation; not asking at all would
  // mean booking a screening procedure for a potentially diagnostic problem.
  if (!redFlagsAddressed(readings)) {
    if (exhausted("red_flag_symptoms")) return giveUp("red_flag_symptoms", "whether you have any symptoms");
    return {
      ...withRecommendation,
      outcome: "ASK",
      gate: "safety",
      reason: "Screening is indicated but symptoms have never been asked about.",
      missingSlot: "red_flag_symptoms",
      say: RED_FLAG_QUESTION,
    };
  }

  // --- Gate 5: readiness ---------------------------------------------------
  // Read from signals, never from facts. The record being complete is not
  // consent, and this is the gate that keeps a well-informed agent from
  // steamrolling an ambivalent person.
  const readiness = signals?.readiness ?? "not_raised";
  if (readiness !== "explicit_request") {
    const ambivalent = readiness === "ambivalent" || signals?.hesitation === "strong";
    return {
      ...withRecommendation,
      outcome: "ASK",
      gate: "readiness",
      reason: ambivalent
        ? `Patient is ambivalent (readiness=${readiness}, hesitation=${signals?.hesitation ?? "unknown"}). Complete facts are not consent.`
        : `Patient has not asked to proceed (readiness=${readiness}).`,
      missingSlot: "readiness",
      say: ambivalent
        ? "Plenty of people feel exactly that way about it, and there's no rush from my side. " +
          "What's the part that puts you off most? I'd rather talk that through than push you."
        : `${recommendation.patientSummary} Would you like me to find you an appointment?`,
    };
  }

  // --- ACT -----------------------------------------------------------------
  return {
    ...withRecommendation,
    outcome: "ACT",
    gate: "act",
    reason: `All gates passed: screening indicated (${recommendation.riskTier}), symptoms addressed, patient explicitly requested booking.`,
    missingSlot: null,
    say: "",
  };
}
