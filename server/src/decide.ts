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
import type { ShippingAddress } from "./shipping.js";
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
  | "shipping"
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

/**
 * Recognizes a question about a booking that already exists (the date, the
 * confirmation number, the clinic) so the already_resolved gate can answer
 * it instead of repeating the same "you're all set" line no matter what was
 * asked -- the exact bug a live transcript turned up: "what's the date
 * again?" three times in a row got the identical non-answer each time. This
 * is the one place decide() looks at raw turn text rather than structured
 * state, because there is nothing to extract into a fact here -- the answer
 * already exists, in full, on the booking made earlier this session.
 */
const BOOKING_DETAIL_PATTERN = /\b(date|when|day|time|calendar|confirm(ation|ed)?|clinic|where)\b/i;

/**
 * Recognizes the patient signaling they're done -- a plain "no, that's it" or
 * "nothing else" -- so already_resolved can close the conversation instead of
 * asking "anything else I can help with?" a second time. Checked before
 * BOOKING_DETAIL_PATTERN, since a farewell wins over an incidental word match
 * ("no, that's it, don't need the date" is still a farewell). This exists
 * because of a live voice call where the patient's silence after an
 * unanswered "anything else?" got fed back through as another turn, and the
 * generic line repeated verbatim -- see agent_configs/
 * 05_daphne_scheduling_voice.create.json's now-fixed `end_call` wiring for
 * the other half of that bug. This half matters independent of that fix:
 * text mode has no call to end, so without this the same repeat would still
 * read as "not listening" there too.
 */
const CLOSING_PATTERN =
  /\b(?:that'?s (?:it|all)|nothing else|no,? thanks?(?: you)?|i'?m (?:good|all set|all done|done)|we'?re (?:good|all set|done)|no more questions)\b/i;

/** Everything already_resolved needs to answer a "what did you book me"
 *  question, pre-formatted for speech in sessions.ts using the same helper
 *  the original booking confirmation used -- decide.ts has no reason to
 *  know how to format a Date. */
export interface BookingSummary {
  confirmationId: string;
  clinic: string;
  when: string;
}

/** already_resolved's other terminal state -- everything it needs to answer
 *  "what's going on with my appointment" for a session that was waitlisted
 *  rather than booked. Kept as its own type rather than folded into
 *  BookingSummary because a waitlist genuinely lacks a clinic/date to give
 *  back; conflating the two would mean inventing one. */
export interface WaitlistSummary {
  waitlistId: string;
  reason: string;
  nextStep: string;
}

export interface Decision {
  turn: number;
  outcome: Outcome;
  /** The gate that determined the outcome. */
  gate: GateName;
  reason: string;
  /** For ASK: the one thing being asked for, and the authored wording. */
  missingSlot:
    | Slot
    | "red_flag_symptoms"
    | "readiness"
    | "scheduling_preference"
    | "escort_contact"
    | "shipping_address"
    | null;
  say: string;
  /** Set only on ACT, alongside escortContact -- see that field's note.
   *  Null until the shipping gate has actually fired once. */
  shippingAddress: ShippingAddress | null;
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
  /** Set once a resolution exists -- booked *or* waitlisted -- so the engine
   *  stops trying to book again. Both are terminal for this session: a
   *  waitlisted screening doesn't become "unresolved" just because there's no
   *  confirmation number, and re-running the gates below on a waitlisted
   *  session would silently re-attempt scheduling every subsequent turn --
   *  regenerating a fresh waitlist id, re-sending the mocked escort invite,
   *  and repeating the same message, forever. That was a real bug, not a
   *  hypothetical one: found by a scripted patient who never got a
   *  confirmed slot in the first place. */
  alreadyResolved: boolean;
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
  /** Set once the shipping gate has asked and gotten any reply (including a
   *  decline), or null while still waiting on that ask. See shipping.ts and
   *  the "shipping" gate below. Same non-blocking shape as escortContact. */
  shippingAddress: ShippingAddress | null;
  /** The current turn's raw text, verbatim. Used only by already_resolved,
   *  to tell "what's the date again?" apart from anything else a patient
   *  might say once already booked -- see BOOKING_DETAIL_PATTERN. Every
   *  other gate in this file reads structured facts/signals instead; this is
   *  the one deliberate exception, because recalling an already-decided
   *  answer isn't a new decision that belongs behind extraction. */
  patientTurn: string;
  /** The existing booking's details, once one exists, so already_resolved
   *  has something to answer with. Null before a booking exists, and null
   *  (not a booking) when the resolution was a waitlist -- see `waitlist`
   *  for that case instead. */
  booking: BookingSummary | null;
  /** The existing waitlist's details, once a session resolved to one, so
   *  already_resolved has something to answer with. Null before a
   *  resolution exists, and null (not a waitlist) once an actual booking
   *  exists -- see `booking` for that case instead. Exactly one of
   *  `booking`/`waitlist` is non-null whenever `alreadyResolved` is true. */
  waitlist: WaitlistSummary | null;
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
    shippingAddress: null,
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

  if (input.alreadyResolved) {
    if (CLOSING_PATTERN.test(input.patientTurn)) {
      return {
        ...base,
        outcome: "ASK",
        gate: "already_resolved",
        reason: `Screening is already ${input.booking ? "booked" : "waitlisted"} and the patient signaled they're done -- closing, not re-asking.`,
        missingSlot: null,
        say: input.booking
          ? "Sounds good — take care, and don't hesitate to reach out if anything comes up before your appointment."
          : "Sounds good — I'll keep watching that cancellation list for you and reach out the moment something opens up. Take care in the meantime.",
      };
    }
    if (input.booking && BOOKING_DETAIL_PATTERN.test(input.patientTurn)) {
      return {
        ...base,
        outcome: "ASK",
        gate: "already_resolved",
        reason: "Booking already exists; patient asked for its details again -- answering, not repeating the generic line.",
        missingSlot: null,
        say:
          `You're booked at ${input.booking.clinic} on ${input.booking.when}. Your confirmation number ` +
          `is ${input.booking.confirmationId}. Anything else I can help with?`,
      };
    }
    if (input.waitlist && BOOKING_DETAIL_PATTERN.test(input.patientTurn)) {
      return {
        ...base,
        outcome: "ASK",
        gate: "already_resolved",
        reason: "Waitlisted already; patient asked for its details again -- answering, not repeating the generic line.",
        missingSlot: null,
        say:
          `You're on the cancellation list, reference ${input.waitlist.waitlistId}. ${input.waitlist.reason} ` +
          `${input.waitlist.nextStep} Anything else I can help with?`,
      };
    }
    return {
      ...base,
      outcome: "ASK",
      gate: "already_resolved",
      reason: `Screening is already ${input.booking ? "booked" : "waitlisted"} for this session.`,
      missingSlot: null,
      say: input.booking
        ? "You're all set for the colonoscopy. Anything else I can help with?"
        : "You're still on the cancellation list for the colonoscopy — I'll reach out the moment something opens up. Anything else I can help with?",
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

  // --- Gate 8: shipping address ---------------------------------------------
  // The prep kit has to go somewhere. Asked once, right after the pickup
  // question -- same non-blocking shape as escort: a decline ("I'll just
  // grab one at the pharmacy") or an unparseable reply are just as final as
  // a real address, since a patient managing their own prep kit is a normal
  // outcome, not a problem to escalate.
  if (!input.shippingAddress) {
    return {
      ...withRecommendation,
      outcome: "ASK",
      gate: "shipping",
      reason: "Pickup contact is settled but no shipping address has been asked for yet.",
      missingSlot: "shipping_address",
      say:
        "Last thing — where should I ship your prep kit so it arrives about a week before your " +
        "appointment? If you'd rather pick one up yourself at a pharmacy, that's fine too.",
    };
  }

  // --- ACT -----------------------------------------------------------------
  return {
    ...withRecommendation,
    outcome: "ACT",
    gate: "act",
    bookWithinDays: recommendation?.bookWithinDays ?? SCHEDULING_ONLY_BOOKING_WINDOW_DAYS,
    escortContact: input.escortContact,
    shippingAddress: input.shippingAddress,
    reason: recommendation
      ? `All gates passed: screening indicated (${recommendation.riskTier}), symptoms addressed, patient has asked to proceed.`
      : "Scheduling-only session: no eligibility check performed, symptoms addressed, patient has asked to proceed.",
    missingSlot: null,
    say: "",
  };
}
