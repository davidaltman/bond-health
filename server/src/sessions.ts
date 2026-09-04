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
  kind: "turn_received" | "operations_applied" | "extraction_failed" | "extraction_skipped";
  detail: string;
  applied?: AppliedOperation[];
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
  };
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
