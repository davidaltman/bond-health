import { useCallback, useRef, useState } from "react";
import { createSession, sendMessage } from "./api";
import type {
  ClinicalFact,
  ConversationSignals,
  Decision,
  Resolution,
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
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setIsThinking(false);
      }
    },
    [isThinking, patient.name, patient.age],
  );

  return { transcript, facts, signals, decision, resolution, isThinking, errorMessage, send, reset };
}
