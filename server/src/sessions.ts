/**
 * Live conversation sessions.
 *
 * Holds one ledger per call and feeds turns through the extraction pass as
 * they arrive. Storage is an in-memory Map: enough for this exercise, and the
 * shape persists cleanly if it ever needs to. Cross-session resume is
 * deliberately out of scope -- deciding what a months-old fact still means is
 * its own design problem, not a storage detail.
 *
 * Two things here exist because of how voice actually behaves:
 *
 * 1. Turns are processed one at a time per session. A patient can finish two
 *    sentences before the first extraction returns, and operations that
 *    reference fact ids must apply in the order they were spoken.
 * 2. Extraction failures are recorded and swallowed. Losing a fact is bad;
 *    breaking the call in progress is worse.
 */
import { randomUUID } from "node:crypto";
import { extractTurn } from "./extract-turn.js";
import { decide, type BookingSummary, type Decision, type SessionMode, type WaitlistSummary } from "./decide.js";
import { composeReply, type ComposedReply } from "./compose.js";
import {
  scheduleScreening,
  sendEscortInvite,
  sendPatientInvite,
  type EscortInvite,
  type PatientInvite,
  type SchedulingResult,
} from "./scheduler.js";
import { describePreference, parseSchedulingPreference, type SchedulingPreference } from "./preference.js";
import { parseEscortReply, type EscortContact } from "./escort.js";
import { parseShippingAddress, type ShippingAddress } from "./shipping.js";
import { classifyClosingIntent, classifyDecline, classifySoonestPreference } from "./logistics-llm.js";
import { classifyRedFlagSymptoms } from "./red-flag-llm.js";
import {
  applyOperations,
  createLedger,
  liveFacts,
  summarizeForPrompt,
  type AppliedOperation,
  type ProposedOperation,
  type ClinicalFact,
  type ConversationSignals,
  type LedgerState,
} from "./ledger.js";

export interface SessionTurn {
  index: number;
  role: "agent" | "user";
  content: string;
  at: string;
}

export interface TraceEvent {
  turn: number;
  at: string;
  kind:
    | "turn_received"
    | "operations_applied"
    | "extraction_failed"
    | "extraction_skipped"
    | "decision"
    | "resolution";
  detail: string;
  applied?: AppliedOperation[];
  decision?: Decision;
}

export interface ReviewFlag {
  turn: number;
  note: string;
  /** What the reviewer says should have happened, when they know. */
  expectedOutcome: string | null;
  at: string;
}

export interface Session {
  id: string;
  createdAt: string;
  patientName: string | null;
  patientAge: number | null;
  /** See decide.ts's SessionMode. Fixed for the life of the session -- start
   *  a new session to change it, rather than switching mid-conversation,
   *  since the two modes ask genuinely different questions about the same
   *  patient and mixing them mid-session has no well-defined meaning. */
  mode: SessionMode;
  turns: SessionTurn[];
  ledger: LedgerState;
  signals: ConversationSignals | null;
  trace: TraceEvent[];
  /** One entry per patient turn: the outcome, the gate that fired, and why. */
  decisions: Decision[];
  /** The resolution, once ACT has produced one. */
  resolution: SchedulingResult | null;
  /** How often each slot has been asked for, so the engine can stop looping. */
  askCounts: Record<string, number>;
  /** Sticky across the day/time sub-dialog; see decide.ts's readiness gate. */
  bookingRequested: boolean;
  /** The patient's stated day/time preference, once given. Logistics, not a
   *  clinical fact, so it lives here rather than in the ledger. */
  schedulingPreference: SchedulingPreference | null;
  /** Set once the escort gate has asked and gotten any reply, including a
   *  decline. See escort.ts and decide.ts's "escort" gate. */
  escortContact: EscortContact | null;
  /** The mocked calendar-invite outcome, once ACT has run. Null until then,
   *  and `{ sent: false, to: null }` (not null) if ACT ran but no contact was
   *  ever given -- the two are different facts about the session. */
  escortInvite: EscortInvite | null;
  /** Set once the shipping gate has asked and gotten any reply, including a
   *  decline. See shipping.ts and decide.ts's "shipping" gate. */
  shippingAddress: ShippingAddress | null;
  /** The patient's own mocked calendar-invite outcome, once a booking
   *  exists. Unlike escortInvite there is no decline case -- see
   *  sendPatientInvite. */
  patientInvite: PatientInvite | null;
  /** Reviewer flags raised against specific turns. */
  flags: ReviewFlag[];
  /** Serializes extraction so turns apply in spoken order. */
  queue: Promise<void>;
}

const sessions = new Map<string, Session>();

export function createSession(
  patientName?: string | null,
  patientAge?: number | null,
  mode: SessionMode = "full",
): Session {
  const session: Session = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    patientName: patientName ?? null,
    patientAge: typeof patientAge === "number" && Number.isFinite(patientAge) ? patientAge : null,
    mode,
    turns: [],
    ledger: createLedger(),
    signals: null,
    trace: [],
    decisions: [],
    resolution: null,
    askCounts: {},
    bookingRequested: false,
    schedulingPreference: null,
    escortContact: null,
    escortInvite: null,
    shippingAddress: null,
    patientInvite: null,
    flags: [],
    queue: Promise.resolve(),
  };
  sessions.set(session.id, session);
  return session;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export interface TurnResult {
  turnIndex: number;
  applied: AppliedOperation[];
  facts: ClinicalFact[];
  signals: ConversationSignals | null;
  decision: Decision | null;
  resolution: SchedulingResult | null;
}

/** Whitespace/case-insensitive comparison for the echo guard below -- exact
 *  content match only (no fuzzy/substring matching), since the failure mode
 *  it exists for reproduces the agent's own last line byte-for-byte. A loose
 *  match would risk mistaking a patient's genuine, if unusual, repetition of
 *  Daphne's own words for a desync. */
function normalizeForEchoCheck(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Records a turn and, for patient turns, extracts what it changes.
 *
 * Agent turns are stored but not extracted -- they cost a model call and say
 * nothing about the patient. They are still needed as context, since "yes,
 * about eight years ago" only means something next to the question it answers.
 */
export async function appendTurn(
  session: Session,
  role: "agent" | "user",
  content: string,
): Promise<TurnResult> {
  const turn: SessionTurn = {
    index: session.turns.length,
    role,
    content,
    at: new Date().toISOString(),
  };
  session.turns.push(turn);
  session.trace.push({
    turn: turn.index,
    at: turn.at,
    kind: "turn_received",
    detail: `${role}: ${content.slice(0, 120)}`,
  });

  // Guards against a live desync seen in conv_8201m22mqqnafgza85n87yx7csbg:
  // the shipping question came back from advance_scheduling as a tool
  // result, was never actually spoken to the patient (no agent "message"
  // entry for it in the transcript), and the very next advance_scheduling
  // call arrived with `message` set to that exact question text -- the
  // ElevenLabs agent re-invoking the tool with its own last output instead
  // of a real reply. Processing that as if the patient said it is worse
  // than doing nothing: the shipping question's own wording ("...pick one
  // up yourself at a pharmacy...") matches DECLINE_PATTERN, so the gate
  // silently recorded "no address" before the patient ever heard the ask.
  // A patient reply that happens to exactly echo Daphne's own immediately
  // preceding line, whitespace/case aside, is never a genuine answer --
  // treat it exactly like an empty turn: skip extraction and decide()
  // entirely, and leave askCounts/ledger/resolution untouched so the next
  // real reply is judged against the same question, not one already
  // (wrongly) marked answered. See
  // docs/bug-investigation-conv_8201m22mqqnafgza85n87yx7csbg.md.
  const lastAgentTurn = [...session.turns].slice(0, -1).reverse().find((candidate) => candidate.role === "agent");
  const isEchoOfLastAgentTurn =
    role === "user" && lastAgentTurn != null && normalizeForEchoCheck(content) === normalizeForEchoCheck(lastAgentTurn.content);

  if (role !== "user" || !content.trim() || isEchoOfLastAgentTurn) {
    session.trace.push({
      turn: turn.index,
      at: new Date().toISOString(),
      kind: "extraction_skipped",
      detail: isEchoOfLastAgentTurn
        ? "patient turn is a verbatim echo of Daphne's own preceding line -- tool/turn-taking desync, not a real reply; decision left unchanged"
        : role === "user"
          ? "empty patient turn"
          : "agent turn, nothing to extract",
    });
    return {
      turnIndex: turn.index,
      applied: [],
      facts: liveFacts(session.ledger),
      signals: session.signals,
      decision: session.decisions.at(-1) ?? null,
      resolution: session.resolution,
    };
  }

  let applied: AppliedOperation[] = [];
  const work = session.queue.then(async () => {
    try {
      const precedingAgentTurn =
        [...session.turns]
          .slice(0, turn.index)
          .reverse()
          .find((candidate) => candidate.role === "agent")?.content ?? null;

      // Which gate this turn is answering is already known from the *last*
      // decision, the sticky bookingRequested flag, and whether a resolution
      // already exists -- none of those depend on this turn's extraction --
      // so the conditional judgment call (see logistics-llm.ts and
      // red-flag-llm.ts) can start at the same time as extraction rather
      // than after it. Promise.all below is what makes that concurrent
      // instead of sequential; skipped entirely on turns where no gate makes
      // it relevant, so an ordinary history-taking turn never pays for it.
      // expectingClosingIntent is the same idea for post-booking follow-ups:
      // session.resolution is already set before this turn's extractTurn
      // runs. expectingRedFlagAnswer is the same idea for the turn right
      // after decide() asked RED_FLAG_QUESTION (missingSlot is set only for
      // that ask, never for the earlier already-a-red-flag HANDOFF branch).
      const priorDecision = session.decisions.at(-1) ?? null;
      const priorGate = priorDecision?.gate ?? null;
      const expectingSchedulingPreference = session.bookingRequested && !session.schedulingPreference;
      const expectingEscort = priorGate === "escort" && !session.escortContact;
      const expectingShipping = priorGate === "shipping" && !session.shippingAddress;
      const expectingClosingIntent = session.resolution != null;
      const expectingRedFlagAnswer = priorDecision?.missingSlot === "red_flag_symptoms";

      const conditionalCall: Promise<
        | { kind: "soonest"; soonestOk: boolean }
        | { kind: "decline"; declined: boolean }
        | { kind: "closing"; intent: "closing" | "details" | "other" }
        | { kind: "redFlags"; flags: string[] }
        | null
      > = expectingSchedulingPreference
        ? classifySoonestPreference({ question: precedingAgentTurn, reply: content }).then(
            (judgment) => ({ kind: "soonest" as const, ...judgment }),
          )
        : expectingEscort
          ? classifyDecline({ askedFor: "escort_contact", question: precedingAgentTurn, reply: content }).then(
              (judgment) => ({ kind: "decline" as const, ...judgment }),
            )
          : expectingShipping
            ? classifyDecline({ askedFor: "shipping_address", question: precedingAgentTurn, reply: content }).then(
                (judgment) => ({ kind: "decline" as const, ...judgment }),
              )
            : expectingClosingIntent
              ? classifyClosingIntent({ reply: content }).then(
                  (judgment) => ({ kind: "closing" as const, ...judgment }),
                )
              : expectingRedFlagAnswer
                ? classifyRedFlagSymptoms({ reply: content }).then(
                    (judgment) => ({ kind: "redFlags" as const, ...judgment }),
                  )
                : Promise.resolve(null);

      const [extraction, conditionalJudgment] = await Promise.all([
        extractTurn({
          factsOnFile: summarizeForPrompt(session.ledger),
          precedingAgentTurn,
          patientTurn: content,
        }),
        // A failed call degrades to the regex fallback inside
        // preference.ts/escort.ts/shipping.ts/decide.ts, or to extractTurn's
        // own general symptom handling for red flags (see red-flag-llm.ts's
        // header comment) -- same discipline as extractTurn's own catch
        // block below -- it must never take the turn's already-successful
        // extraction down with it, which is why this has its own catch
        // rather than sharing the outer try/catch.
        conditionalCall.catch((error) => {
          session.trace.push({
            turn: turn.index,
            at: new Date().toISOString(),
            kind: "extraction_failed",
            detail: `conditional classification failed, falling back to regex: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
          return null;
        }),
      ]);

      // A red-flag judgment becomes ordinary ProposedOperation "add"s,
      // merged with extractTurn's own, so decide() never learns this call
      // exists -- it just sees more facts on the ledger, same as any other
      // turn. Deliberately not deduped against whatever attribute
      // extractTurn itself chose for the same statement (e.g. "bleeding"):
      // two ledger rows for one real-world symptom is a minor cosmetic
      // redundancy, not a correctness problem, and requirements.ts's exact
      // canonical-attribute match only needs one of them to fire the safety
      // gate.
      const redFlagOps: ProposedOperation[] =
        conditionalJudgment?.kind === "redFlags"
          ? conditionalJudgment.flags.map((attribute) => ({
              op: "add",
              factRef: null,
              subject: "self",
              category: "symptom",
              attribute,
              value: content,
              onsetAge: null,
              lastOccurred: null,
              status: "active",
              confidence: "high",
              sourceQuote: content,
              note: null,
            }))
          : [];

      applied = applyOperations(session.ledger, [...extraction.operations, ...redFlagOps], turn.index);
      session.signals = { turn: turn.index, ...extraction.signals };
      session.trace.push({
        turn: turn.index,
        at: new Date().toISOString(),
        kind: "operations_applied",
        detail: applied.length ? summarizeApplied(applied) : "no changes to the record",
        applied,
      });

      // Parsed deterministically (preference.ts), not through the clinical
      // extraction pass -- a day/time is logistics, not history. Gated on
      // booking intent (this turn's or already sticky) so a stray weekday
      // mentioned earlier in the conversation for an unrelated reason never
      // gets mistaken for a scheduling answer.
      // justAskedToBook covers the one turn where a booking request and a
      // preference arrive in the same breath ("sure, book it, but early
      // Monday mornings work best") -- session.bookingRequested isn't sticky
      // yet at the point conditionalCall was kicked off above, so that one
      // turn's soonest judgment (if any) never got started concurrently.
      // Falling back to a plain regex read here rather than firing a second,
      // sequential LLM call keeps that rare turn fast at the cost of using
      // the less precise signal exactly once, which is an acceptable trade.
      const justAskedToBook = session.signals.readiness === "explicit_request";
      if ((justAskedToBook || session.bookingRequested) && !session.schedulingPreference) {
        const soonestOk = conditionalJudgment?.kind === "soonest" ? conditionalJudgment.soonestOk : null;
        const preference = parseSchedulingPreference(content, soonestOk);
        if (preference) session.schedulingPreference = preference;
      }

      // Same reasoning as above, gated differently: a pickup contact only
      // means anything as the answer to the escort gate's specific question,
      // so this only parses when that gate is what just asked -- not on
      // booking intent generally, which would risk reading a stray name
      // mentioned for some other reason as the pickup answer.
      if (session.decisions.at(-1)?.gate === "escort" && !session.escortContact) {
        const declined = conditionalJudgment?.kind === "decline" ? conditionalJudgment.declined : null;
        session.escortContact = parseEscortReply(content, declined);
      }

      // Same reasoning again, one gate later: a shipping address only means
      // anything as the answer to the shipping gate's specific question.
      if (session.decisions.at(-1)?.gate === "shipping" && !session.shippingAddress) {
        const declined = conditionalJudgment?.kind === "decline" ? conditionalJudgment.declined : null;
        session.shippingAddress = parseShippingAddress(content, declined);
      }

      runDecision(session, turn.index, {
        patientTurn: content,
        closingIntent: conditionalJudgment?.kind === "closing" ? conditionalJudgment.intent : null,
      });
    } catch (error) {
      session.trace.push({
        turn: turn.index,
        at: new Date().toISOString(),
        kind: "extraction_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      // eslint-disable-next-line no-console
      console.error(`[session ${session.id}] turn ${turn.index} extraction failed:`, error);
    }
  });
  session.queue = work;
  await work;

  return {
    turnIndex: turn.index,
    applied,
    facts: liveFacts(session.ledger),
    signals: session.signals,
    decision: session.decisions.at(-1) ?? null,
    resolution: session.resolution,
  };
}

/**
 * Runs the gates against current state and, when the outcome is ACT, carries it
 * out.
 *
 * ACT is the only outcome with a side effect, and it happens here rather than
 * inside decide() so that deciding stays a pure function of state -- the eval
 * suite can assert on decisions without booking anything, and a reviewer can
 * replay the gates without touching the scheduler.
 */
function runDecision(
  session: Session,
  turn: number,
  extras: {
    patientTurn: string;
    closingIntent: "closing" | "details" | "other" | null;
  },
): void {
  const decision = decide({
    turn,
    patientAge: session.patientAge,
    facts: liveFacts(session.ledger),
    signals: session.signals,
    alreadyResolved: session.resolution != null,
    askCounts: session.askCounts,
    bookingRequested: session.bookingRequested,
    schedulingPreference: session.schedulingPreference,
    escortContact: session.escortContact,
    shippingAddress: session.shippingAddress,
    patientTurn: extras.patientTurn,
    closingIntent: extras.closingIntent,
    booking: bookingSummary(session.resolution),
    waitlist: waitlistSummary(session.resolution),
    mode: session.mode,
  });

  if (decision.missingSlot) {
    session.askCounts[decision.missingSlot] = (session.askCounts[decision.missingSlot] ?? 0) + 1;
  }

  // Persist booking intent for the next turn. A fresh ambivalent turn always
  // routes back through the readiness gate inside decide() regardless of this
  // flag, so clearing it here on that outcome can't suppress a change of
  // heart -- see decide.ts's wantsToBook. Both sub-dialogs that follow
  // readiness (day/time, then pickup contact) need this kept sticky, or the
  // very next turn's readiness recompute sees no fresh booking signal in an
  // answer like "my daughter can pick me up" and loops back to "would you
  // like me to book it?" -- the exact repetition bug this flag exists to
  // prevent, just one gate later than where it was first found.
  if (decision.gate === "readiness") session.bookingRequested = false;
  else if (
    decision.gate === "scheduling" ||
    decision.gate === "escort" ||
    decision.gate === "shipping" ||
    decision.outcome === "ACT"
  )
    session.bookingRequested = true;

  if (decision.outcome === "ACT" && decision.bookWithinDays != null) {
    const result = scheduleScreening(decision.bookWithinDays, session.schedulingPreference, decision.shippingAddress);
    session.resolution = result;
    // Mocked, deliberately -- see escort.ts's header. Runs regardless of
    // booking outcome so `session.escortInvite` always reflects "did we ask
    // and what happened," not just the happy path.
    const invite = sendEscortInvite(decision.escortContact);
    session.escortInvite = invite;
    if (result.status === "booked") {
      // Unlike escortInvite, only sent on an actual booking -- there is no
      // appointment to put on the patient's own calendar otherwise.
      const patientInvite = sendPatientInvite(session.patientName, result.booking.slot);
      session.patientInvite = patientInvite;
      const preferenceNote =
        session.schedulingPreference && !result.matchedPreference
          ? ` I couldn't match ${describePreference(session.schedulingPreference)} exactly, so here's the closest opening I could get:`
          : "";
      const escortNote = invite.sent
        ? ` I've sent a calendar invite to ${invite.to} for the pickup.`
        : "";
      const patientInviteNote = patientInvite.sent ? " I've added it to your own calendar too." : "";
      decision.say =
        `You're booked.${preferenceNote} ${formatSlot(result.booking.slot)}. Your confirmation number is ` +
        `${result.booking.confirmationId}, and I'll send the prep instructions over.${escortNote}${patientInviteNote} ` +
        `${result.booking.prepInstructions[1]}`;
    } else {
      decision.say = `I couldn't get you in inside the window I'd want for you — ${result.reason} ${result.nextStep}`;
    }
    session.trace.push({
      turn,
      at: new Date().toISOString(),
      kind: "resolution",
      detail:
        result.status === "booked"
          ? `booked ${result.booking.confirmationId} at ${result.booking.slot.clinic} (${
              result.matchedPreference ? "matched preference" : "closest to preference"
            })`
          : `waitlisted ${result.waitlistId}: ${result.reason}`,
    });
  }

  session.decisions.push(decision);
  session.trace.push({
    turn,
    at: new Date().toISOString(),
    kind: "decision",
    detail: `${decision.outcome} via ${decision.gate}: ${decision.reason}`,
    decision,
  });
}

/**
 * Turns a reviewed session into a scenario the eval suite can run.
 *
 * This is the join between the two halves of "watching and improving": a turn
 * a human flagged in a live session becomes a regression case, in the same
 * format as the hand-written ones, without anyone retyping the conversation.
 *
 * Observed outcomes are written in as the expectations, which is deliberate but
 * needs saying out loud: for a flagged turn the observed outcome is by
 * definition the wrong one. The export marks those turns so the reviewer edits
 * them to what should have happened. Exporting the bug as the expectation would
 * lock in the very behaviour that got flagged.
 */
export function exportScenario(session: Session, name: string): Record<string, unknown> {
  const flaggedTurns = new Map(session.flags.map((flag) => [flag.turn, flag]));
  const decisionsByTurn = new Map(session.decisions.map((decision) => [decision.turn, decision]));

  const turns = session.turns.map((turn) => {
    const entry: Record<string, unknown> = { role: turn.role, content: turn.content };
    if (turn.role !== "user") return entry;

    const decision = decisionsByTurn.get(turn.index);
    const flag = flaggedTurns.get(turn.index);
    if (flag) {
      entry.FIXME = `Flagged: ${flag.note}. Observed ${decision?.outcome ?? "nothing"}; set expectOutcome to what should have happened.`;
      entry.expectOutcome = flag.expectedOutcome ?? decision?.outcome ?? null;
    } else if (decision) {
      entry.expectOutcome = decision.outcome;
      entry.expectGate = decision.gate;
    }
    return entry;
  });

  return {
    name,
    description: `Captured from a live session on ${new Date().toISOString().slice(0, 10)}.${
      session.flags.length ? ` ${session.flags.length} flagged turn(s) need expectations reviewed.` : ""
    }`,
    patientName: session.patientName,
    patientAge: session.patientAge,
    sessionMode: session.mode,
    turns,
    expect: {
      finalOutcome: session.decisions.at(-1)?.outcome ?? null,
      resolution: session.resolution?.status ?? "none",
    },
  };
}

/** waitlistSummary's counterpart -- null before a resolution exists, or if
 *  the outcome was an actual booking rather than a waitlist, since there's
 *  a confirmation number to recall in that case instead (see bookingSummary
 *  below). */
function waitlistSummary(resolution: SchedulingResult | null): WaitlistSummary | null {
  if (!resolution || resolution.status !== "waitlisted") return null;
  return {
    waitlistId: resolution.waitlistId,
    reason: resolution.reason,
    nextStep: resolution.nextStep,
  };
}

/** Turns the resolution into the minimal thing decide.ts's already_resolved
 *  gate needs to answer "what did you book me" -- null before a booking
 *  exists, or if the outcome was a waitlist rather than a booking, since
 *  there's no date to recall in that case either (see waitlistSummary
 *  above for that case). */
function bookingSummary(resolution: SchedulingResult | null): BookingSummary | null {
  if (!resolution || resolution.status !== "booked") return null;
  return {
    confirmationId: resolution.booking.confirmationId,
    clinic: resolution.booking.slot.clinic,
    when: formatWhen(resolution.booking.slot.startsAt),
  };
}

/** Just the date/time half of a slot, in speakable form -- e.g. "Monday,
 *  September 28 at 9:00 AM". Split out from formatSlot so already_resolved's
 *  "You're booked at {clinic} on {when}" doesn't have to string-surgery a
 *  clinic name back out of a combined sentence. */
function formatWhen(startsAt: string): string {
  const when = new Date(startsAt);
  return `${when.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  })} at ${when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

function formatSlot(slot: { clinic: string; startsAt: string }): string {
  return `${slot.clinic} on ${formatWhen(slot.startsAt)}`;
}

function summarizeApplied(applied: AppliedOperation[]): string {
  const counts = new Map<string, number>();
  for (const item of applied) counts.set(item.outcome, (counts.get(item.outcome) ?? 0) + 1);
  return [...counts.entries()].map(([outcome, count]) => `${outcome}=${count}`).join(", ");
}

/** Waits for any in-flight extraction, so an end-of-call read isn't racing the
 *  last turn the patient spoke. */
export async function settle(session: Session): Promise<void> {
  await session.queue;
}

export interface ExchangeResult extends TurnResult {
  reply: ComposedReply;
}

/**
 * One full turn of the text conversation: patient speaks, Daphne answers.
 *
 * This is where the loop actually closes. In the voice path the agent talks
 * from its own prompt and the engine watches from the side, which means the
 * gates audit the conversation rather than steer it. Here Daphne's reply *is*
 * the decision, so "the patient was told X" and "the system decided X" cannot
 * drift apart -- and the reply is recorded as an agent turn, so the next
 * extraction sees the question it is answering.
 */
export async function exchange(session: Session, content: string): Promise<ExchangeResult> {
  const turnResult = await appendTurn(session, "user", content);

  const decision = turnResult.decision;
  if (!decision) {
    const reply: ComposedReply = {
      text: "Sorry — I lost my train of thought there. Could you say that again?",
      acknowledgment: "",
      substance: "",
      guardTripped: "no decision was produced for this turn",
    };
    await appendTurn(session, "agent", reply.text);
    return { ...turnResult, reply };
  }

  // runDecision() already incremented askCounts for this decision's slot (if
  // any) before we get here, so a count of 2+ means this exact question was
  // also asked at least once before -- i.e. what's about to be sent is a
  // verbatim repeat.
  const isRepeat = decision.missingSlot != null && (session.askCounts[decision.missingSlot] ?? 0) >= 2;
  const reply = await composeReply({ decision, signals: session.signals, patientTurn: content, isRepeat });
  await appendTurn(session, "agent", reply.text);

  return { ...turnResult, reply, resolution: session.resolution };
}
