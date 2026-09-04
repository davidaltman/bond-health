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
import { decide, type Decision } from "./decide.js";
import { composeReply, type ComposedReply } from "./compose.js";
import { scheduleScreening, type SchedulingResult } from "./scheduler.js";
import { describePreference, parseSchedulingPreference, type SchedulingPreference } from "./preference.js";
import {
  applyOperations,
  createLedger,
  liveFacts,
  summarizeForPrompt,
  type AppliedOperation,
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
  /** Reviewer flags raised against specific turns. */
  flags: ReviewFlag[];
  /** Serializes extraction so turns apply in spoken order. */
  queue: Promise<void>;
}

const sessions = new Map<string, Session>();

export function createSession(patientName?: string | null, patientAge?: number | null): Session {
  const session: Session = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    patientName: patientName ?? null,
    patientAge: typeof patientAge === "number" && Number.isFinite(patientAge) ? patientAge : null,
    turns: [],
    ledger: createLedger(),
    signals: null,
    trace: [],
    decisions: [],
    resolution: null,
    askCounts: {},
    bookingRequested: false,
    schedulingPreference: null,
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

  if (role !== "user" || !content.trim()) {
    session.trace.push({
      turn: turn.index,
      at: new Date().toISOString(),
      kind: "extraction_skipped",
      detail: role === "user" ? "empty patient turn" : "agent turn, nothing to extract",
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

      const extraction = await extractTurn({
        factsOnFile: summarizeForPrompt(session.ledger),
        precedingAgentTurn,
        patientTurn: content,
      });

      applied = applyOperations(session.ledger, extraction.operations, turn.index);
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
      const justAskedToBook = session.signals.readiness === "explicit_request";
      if ((justAskedToBook || session.bookingRequested) && !session.schedulingPreference) {
        const preference = parseSchedulingPreference(content);
        if (preference) session.schedulingPreference = preference;
      }

      runDecision(session, turn.index);
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
function runDecision(session: Session, turn: number): void {
  const decision = decide({
    turn,
    patientAge: session.patientAge,
    facts: liveFacts(session.ledger),
    signals: session.signals,
    alreadyBooked: session.resolution?.status === "booked",
    askCounts: session.askCounts,
    bookingRequested: session.bookingRequested,
    schedulingPreference: session.schedulingPreference,
  });

  if (decision.missingSlot) {
    session.askCounts[decision.missingSlot] = (session.askCounts[decision.missingSlot] ?? 0) + 1;
  }

  // Persist booking intent for the next turn. A fresh ambivalent turn always
  // routes back through the readiness gate inside decide() regardless of this
  // flag, so clearing it here on that outcome can't suppress a change of
  // heart -- see decide.ts's wantsToBook.
  if (decision.gate === "readiness") session.bookingRequested = false;
  else if (decision.gate === "scheduling" || decision.outcome === "ACT") session.bookingRequested = true;

  if (decision.outcome === "ACT" && decision.recommendation) {
    const result = scheduleScreening(decision.recommendation.bookWithinDays, session.schedulingPreference);
    session.resolution = result;
    if (result.status === "booked") {
      const preferenceNote =
        session.schedulingPreference && !result.matchedPreference
          ? ` I couldn't match ${describePreference(session.schedulingPreference)} exactly, so here's the closest opening I could get:`
          : "";
      decision.say =
        `You're booked.${preferenceNote} ${formatSlot(result.booking.slot)}. Your confirmation number is ` +
        `${result.booking.confirmationId}, and I'll send the prep instructions over. ` +
        `${result.booking.prepInstructions[0]}`;
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
    turns,
    expect: {
      finalOutcome: session.decisions.at(-1)?.outcome ?? null,
      resolution: session.resolution?.status ?? "none",
    },
  };
}

function formatSlot(slot: { clinic: string; startsAt: string }): string {
  const when = new Date(slot.startsAt);
  return `${slot.clinic} on ${when.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  })} at ${when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
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

  const reply = await composeReply({ decision, signals: session.signals, patientTurn: content });
  await appendTurn(session, "agent", reply.text);

  return { ...turnResult, reply, resolution: session.resolution };
}
