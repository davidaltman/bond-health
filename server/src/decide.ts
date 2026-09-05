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
import type { EscortContact } from "./escort.js";
import type { ClinicalFact, ConversationSignals } from "./ledger.js";
import type { SchedulingPreference } from "./preference.js";
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

/**
 * "full" runs every gate, same as always: the engine has to establish
 * screening history, family history, and age before it will say anything is
 * indicated at all. "scheduling_only" skips the sufficiency and eligibility
 * gates entirely and treats the booking itself as already appropriate -- the
 * shape of a patient who already knows they need this (a PCP referral, a
 * standing order, a patient who's already had the guideline conversation
 * elsewhere) and just wants it on the calendar, without being re-asked
 * questions this app has no way to act differently on anyway. Scope and
 * safety are never skippable in either mode -- a red flag or an out-of-scope
 * question gets exactly the same handling regardless of why the session
 * started.
 */
export type SessionMode = "full" | "scheduling_only";

export type GateName =
  | "scope"
  | "safety"
  | "sufficiency"
  | "readiness"
  | "eligibility"
  | "scheduling"
  | "escort"
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

/** Used for ACT in scheduling-only mode, where there is no computed
 *  recommendation to read a window from. The request is treated as already
 *  medically appropriate, so this is a routine, no-special-urgency window
 *  rather than a guess at clinical priority -- see requirements.ts's
 *  bookingWindowDays for how the "full" mode equivalent is derived. */
const SCHEDULING_ONLY_BOOKING_WINDOW_DAYS = 30;

export interface Decision {
  turn: number;
  outcome: Outcome;
  /** The gate that determined the outcome. */
  gate: GateName;
  reason: string;
  /** For ASK: the one thing being asked for, and the authored wording. */
  missingSlot: Slot | "red_flag_symptoms" | "readiness" | "scheduling_preference" | "escort_contact" | null;
  say: string;
  /** Fact ids consulted, so a reviewer can see the basis rather than trust it. */
  evidence: string[];
  /** Null in scheduling_only mode, since eligibility is never computed there. */
  recommendation: ScreeningRecommendation | null;
  /** Set only on ACT. Reads from the recommendation in "full" mode, or falls
   *  back to SCHEDULING_ONLY_BOOKING_WINDOW_DAYS when there is none, so the
   *  scheduler always has a window to book against regardless of mode. */
  bookWithinDays: number | null;
  /** Passed through from input so sessions.ts's ACT side effect can send the
   *  mocked calendar invite without re-deriving whether one was asked for.
   *  Null until the escort gate has actually fired once -- see that gate. */
  escortContact: EscortContact | null;
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
  /**
   * Whether the patient has already explicitly asked to book, sticky across
   * the day/time sub-dialog that follows. Without this, answering "Tuesday
   * morning" to "what day works for you?" would look like a fresh turn with
   * no booking request in it, and the readiness gate would ask "would you
   * like me to find you an appointment?" all over again -- the exact
   * repetition failure this codebase keeps having to design around.
   */
  bookingRequested: boolean;
  /** Set once the patient has given a day/time preference, or null while
   *  still waiting on one. See preference.ts. */
  schedulingPreference: SchedulingPreference | null;
  /** Set once the escort gate has asked and gotten any reply (including a
   *  decline), or null while still waiting on that ask. See escort.ts. Unlike
   *  schedulingPreference, "asked and declined" is itself a terminal value
   *  here, not something the caller retries. */
  escortContact: EscortContact | null;
  /** See SessionMode. Defaults to "full" at the session level; every
   *  DecisionInput is expected to set it explicitly. */
  mode: SessionMode;
}

export function decide(input: DecisionInput): Decision {
  const { turn, facts, signals, mode } = input;
  const readings = readSlots(facts);
  const base = {
    turn,
    evidence: facts.map((fact) => fact.id),
    recommendation: null,
    bookWithinDays: null,
    escortContact: null,
  };

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

  let recommendation: ScreeningRecommendation | null = null;

  if (mode === "full") {
    // --- Gate 3: sufficiency -------------------------------------------------
    // Asks for the single highest-value missing item. Not a questionnaire: the
    // required set is short by design, and this returns after the first gap.
    // Skipped entirely in scheduling_only mode -- see SessionMode.
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
    // The guideline table decides this, not the model. Skipped in
    // scheduling_only mode: there is no "not yet indicated" outcome there,
    // because the mode's whole premise is that eligibility was already
    // decided elsewhere.
    const familyHistory = readSlot(readings, "colorectal_cancer_family_history");
    recommendation = recommendScreening(input.patientAge, familyHistory);

    if (!recommendation.indicated) {
      return {
        ...base,
        recommendation,
        outcome: "ASK",
        gate: "eligibility",
        reason: `Not yet indicated: age ${input.patientAge} is below the start age of ${recommendation.startAge}. ${recommendation.rationale}`,
        missingSlot: null,
        say:
          `Based on what you've told me, routine screening starts at ${recommendation.startAge} for you, ` +
          `so there's nothing due yet. Would you like me to note a reminder for then?`,
      };
    }
  }

  const withRecommendation = { ...base, recommendation };

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
  // "ready" (agreeing in principle -- a plain "yes" to "would you like me to
  // book it?") and "explicit_request" (proactively asking, "can you book
  // it?") are both real consent; they differ in how the patient expressed it,
  // not in whether they gave it. Treating only explicit_request as
  // sufficient left a bare "yes" answering Daphne's own proposal stuck in a
  // loop -- the readiness vocabulary had a value ("ready") that nothing here
  // ever checked.
  const explicitNow = readiness === "explicit_request" || readiness === "ready";
  const ambivalentNow = readiness === "ambivalent" || signals?.hesitation === "strong";

  // Booking intent carries across the day/time sub-dialog below (sticky),
  // but a *fresh* sign of hesitation always overrides stickiness -- someone
  // who said "book it" and then, mid-scheduling, says "actually, wait" must
  // land back here, not get asked what day works as if nothing changed.
  const wantsToBook = !ambivalentNow && (explicitNow || input.bookingRequested);

  if (!wantsToBook) {
    return {
      ...withRecommendation,
      outcome: "ASK",
      gate: "readiness",
      reason: ambivalentNow
        ? `Patient is ambivalent (readiness=${readiness}, hesitation=${signals?.hesitation ?? "unknown"}). Complete facts are not consent.`
        : `Patient has not asked to proceed (readiness=${readiness}).`,
      missingSlot: "readiness",
      say: ambivalentNow
        ? "Plenty of people feel exactly that way about it, and there's no rush from my side. " +
          "What's the part that puts you off most? I'd rather talk that through than push you."
        : recommendation
          ? `${recommendation.patientSummary} Would you like me to find you an appointment?`
          : "Let's get that scheduled for you. Would you like me to find you an appointment?",
    };
  }

  // --- Gate 6: scheduling ----------------------------------------------------
  // Asked only now, after readiness is established -- asking "what day works"
  // before the patient has agreed to anything would presume a consent they
  // haven't given. This is also why it's a separate gate rather than folded
  // into ACT's side effect: ACT should mean "go", not "go, then negotiate."
  if (!input.schedulingPreference && !exhausted("scheduling_preference")) {
    return {
      ...withRecommendation,
      outcome: "ASK",
      gate: "scheduling",
      reason: "Patient is ready to book but hasn't given a day/time preference yet.",
      missingSlot: "scheduling_preference",
      say: "What day or time generally works best for you? Or just say the word and I'll grab the soonest opening.",
    };
  }
  // Exhausted without an answer: proceed anyway. Unlike a missing clinical
  // fact, "couldn't parse a time preference after three tries" isn't a safety
  // concern -- defaulting silently to the soonest opening is the sensible
  // move, not a reason to escalate to a person.

  // --- Gate 7: escort / pickup contact --------------------------------------
  // Sedation means the patient cannot drive themselves home -- the prep
  // instructions already say so, but nobody had actually asked who's coming
  // until this gate existed. Asked once, after a day/time is settled, and
  // -- unlike every other ASK in this file -- never blocking: a decline, a
  // name, or an unparseable reply are all equally final. There is no
  // "exhausted" escalation to HANDOFF here on purpose, because the answer to
  // "I don't have anyone" is "that's fine," not a repeat of the question.
  if (!input.escortContact) {
    return {
      ...withRecommendation,
      outcome: "ASK",
      gate: "escort",
      reason: "Day/time is settled but no pickup contact has been asked for yet.",
      missingSlot: "escort_contact",
      say:
        "One more thing — you'll be sedated for this, so you won't be able to drive yourself home. " +
        "Is there a friend or family member I can send a calendar invite to for the pickup? " +
        "If there isn't anyone yet, that's completely fine — I'll still get you booked.",
    };
  }

  // --- ACT -----------------------------------------------------------------
  return {
    ...withRecommendation,
    outcome: "ACT",
    gate: "act",
    bookWithinDays: recommendation?.bookWithinDays ?? SCHEDULING_ONLY_BOOKING_WINDOW_DAYS,
    escortContact: input.escortContact,
    reason: recommendation
      ? `All gates passed: screening indicated (${recommendation.riskTier}), symptoms addressed, patient has asked to proceed.`
      : "Scheduling-only session: no eligibility check performed, symptoms addressed, patient has asked to proceed.",
    missingSlot: null,
    say: "",
  };
}
