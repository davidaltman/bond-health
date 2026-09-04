import { useCallback, useRef, useState } from "react";
import { createSession, fetchScenarioExport, fetchSessionState, flagTurn, sendMessage } from "./api";
import type {
  ClinicalFact,
  ConversationSignals,
  Decision,
  Resolution,
  ReviewFlag,
  TraceEvent,
  TranscriptEntry,
} from "./types";

let nextEntryId = 0;

/**
 * The text conversation, which is the primary medium here.
 *
 * Unlike the voice hook, this one *awaits* the server: Daphne's reply is the
 * decision, so there is nothing to say until the gates have run. That is the
 * trade the two mediums make. Voice can't block, so the ledger trails the
 * conversation by a beat and the engine can only observe; text can block, so
 * the engine actually drives.
 */
export function useTextConversation(patient: { name: string; age?: number }) {
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [facts, setFacts] = useState<ClinicalFact[]>([]);
  const [signals, setSignals] = useState<ConversationSignals | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const [flags, setFlags] = useState<ReviewFlag[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  const reset = useCallback(() => {
    sessionIdRef.current = null;
    setTranscript([]);
    setFacts([]);
    setSignals(null);
    setDecision(null);
    setResolution(null);
    setTrace([]);
    setFlags([]);
    setErrorMessage(null);
  }, []);

  const send = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed || isThinking) return;
      setErrorMessage(null);
      setTranscript((current) => [
        ...current,
        { id: `entry-${nextEntryId++}`, role: "user", text: trimmed },
      ]);
      setIsThinking(true);
      try {
        if (!sessionIdRef.current) {
          sessionIdRef.current = await createSession(patient.name || "the patient", patient.age);
        }
        const result = await sendMessage(sessionIdRef.current, trimmed);
        setTranscript((current) => [
          ...current,
          { id: `entry-${nextEntryId++}`, role: "agent", text: result.reply.text },
        ]);
        setFacts(result.facts);
        if (result.signals) setSignals(result.signals);
        if (result.decision) setDecision(result.decision);
        setResolution(result.resolution);
        // The review pane reads the server's trace rather than reconstructing
        // one client-side, so what a reviewer sees is the same record the eval
        // export is built from.
        const state = await fetchSessionState(sessionIdRef.current);
        setTrace(state.trace);
        setFlags(state.flags);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setIsThinking(false);
      }
    },
    [isThinking, patient.name, patient.age],
  );

  const flag = useCallback(async (turn: number, note: string) => {
    if (!sessionIdRef.current) return;
    try {
      const result = await flagTurn(sessionIdRef.current, turn, note);
      setFlags(result.flags);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  /** Downloads the session as a scenario file ready for harness_inputs/. */
  const exportScenario = useCallback(async () => {
    if (!sessionIdRef.current) return;
    try {
      const name = `captured_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
      const scenario = await fetchScenarioExport(sessionIdRef.current, name);
      const blob = new Blob([JSON.stringify(scenario, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${name}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  return {
    transcript,
    facts,
    signals,
    decision,
    resolution,
    trace,
    flags,
    isThinking,
    errorMessage,
    send,
    reset,
    flag,
    exportScenario,
  };
}
