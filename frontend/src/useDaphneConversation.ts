import { useCallback, useRef, useState } from "react";
import { Conversation } from "@elevenlabs/client";
import { createSession, fetchSignedUrl, postTurn } from "./api";
import type {
  CallStatus,
  ClinicalFact,
  ConversationSignals,
  SummarizeTranscriptTurn,
  TranscriptEntry,
  TranscriptRole,
} from "./types";

let nextEntryId = 0;

/**
 * Thin wrapper around @elevenlabs/client's Conversation.startSession, mirroring
 * the pattern used by run_elevenlabs_conversation_replay_multitenant.mjs
 * (../../../../utils/) and the collections webapp's AgentConversationPanel --
 * but talking to OUR backend for the signed URL (see server/src/index.ts)
 * instead of ElevenLabs directly, so the API key never reaches the browser.
 */
export function useDaphneConversation(
  dynamicVariables: Record<string, string>,
  patient?: { name: string; age?: number },
) {
  const [status, setStatus] = useState<CallStatus>("idle");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const conversationRef = useRef<Conversation | null>(null);

  // Live clinical memory, maintained server-side while the call runs.
  const [facts, setFacts] = useState<ClinicalFact[]>([]);
  const [signals, setSignals] = useState<ConversationSignals | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  // Turns are chained rather than fired in parallel, so a slow extraction can't
  // let a later turn overtake the one it depends on.
  const turnQueueRef = useRef<Promise<void>>(Promise.resolve());

  /**
   * Hands a turn to the ledger. Deliberately fire-and-forget: the prior
   * prototype awaited mid-call capture inside the agent and produced 15-second
   * silences (docs/prior-art-daphne-history-demo.md). Extraction failing should
   * cost us a fact, never the conversation.
   */
  const recordTurn = useCallback((role: TranscriptRole, text: string) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId || !text.trim()) return;
    turnQueueRef.current = turnQueueRef.current
      .then(async () => {
        const result = await postTurn(sessionId, role, text);
        setFacts(result.facts);
        if (result.signals) setSignals(result.signals);
      })
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.error("live extraction failed for one turn:", error);
      });
  }, []);

  const start = useCallback(
    async (agentId: string) => {
      setErrorMessage(null);
      setTranscript([]);
      setFacts([]);
      setSignals(null);
      sessionIdRef.current = null;
      turnQueueRef.current = Promise.resolve();
      setStatus("connecting");
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("This browser does not support microphone access.");
        }
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());

        const signedUrl = await fetchSignedUrl(agentId);

        // A failure to open the ledger leaves the call fully usable, just
        // without live memory.
        try {
          sessionIdRef.current = await createSession(patient?.name ?? "the patient", patient?.age);
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error("could not open a live session; continuing without live facts:", error);
        }

        const conversation = await Conversation.startSession({
          signedUrl,
          connectionType: "websocket",
          dynamicVariables,
          onConnect: () => setStatus("connected"),
          onDisconnect: () => setStatus((current) => (current === "error" ? current : "ended")),
          onError: (message) => {
            setErrorMessage(message);
            setStatus("error");
          },
          // Fires once per completed turn, which is exactly the granularity
          // the ledger wants -- no extra buffering needed.
          onMessage: ({ message, role }) => {
            setTranscript((current) => [
              ...current,
              { id: `entry-${nextEntryId++}`, role, text: message },
            ]);
            recordTurn(role, message);
          },
        });
        conversationRef.current = conversation;
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
        setStatus("error");
      }
    },
    [dynamicVariables, patient?.name, patient?.age, recordTurn],
  );

  const stop = useCallback(() => {
    void conversationRef.current?.endSession();
    conversationRef.current = null;
  }, []);

  // Used to display a past conversation's transcript (pulled from ElevenLabs
  // by id) in the same panel as a live call, without actually starting a
  // session -- see App.tsx's "generate from conversation id" flow.
  const loadHistoricalTranscript = useCallback((turns: SummarizeTranscriptTurn[]) => {
    void conversationRef.current?.endSession();
    conversationRef.current = null;
    setErrorMessage(null);
    setStatus("ended");
    setTranscript(turns.map((turn) => ({ id: `entry-${nextEntryId++}`, role: turn.role, text: turn.content })));
    // A historical transcript never ran through the live ledger, so showing
    // stale facts beside it would misrepresent where they came from.
    sessionIdRef.current = null;
    setFacts([]);
    setSignals(null);
  }, []);

  return { status, transcript, errorMessage, facts, signals, start, stop, loadHistoricalTranscript };
}
