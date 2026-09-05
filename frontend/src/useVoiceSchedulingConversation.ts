import { useCallback, useRef, useState } from "react";
import { Conversation } from "@elevenlabs/client";
import {
  createSession,
  fetchScenarioExport,
  fetchSessionState,
  fetchSignedUrl,
  flagTurn,
  sendMessage,
} from "./api";
import type {
  CallStatus,
  ClinicalFact,
  ConversationSignals,
  Decision,
  Resolution,
  ReviewFlag,
  SessionMode,
  TraceEvent,
  TranscriptEntry,
} from "./types";

let nextEntryId = 0;

/**
 * Voice, but driving the same decision engine text mode does -- not an
 * observer like useDaphneConversation.ts's legacy 4-stage flow.
 *
 * The ElevenLabs agent behind this (agent_configs/
 * 05_daphne_scheduling_voice.create.json) has no scheduling logic of its
 * own. Its entire job is: call the `advance_scheduling` client tool with
 * whatever the patient just said, then speak back exactly what it returns.
 * The tool handler below is that call -- it hits the identical
 * POST /api/session/:id/message endpoint ChatPanel uses, so voice and text
 * are two mouths on one brain, not two independent implementations that
 * happen to agree. Same gates, same SessionMode, same escort ask.
 *
 * `clientTools` (from @elevenlabs/client) runs the handler in the browser
 * rather than requiring a public webhook the ElevenLabs cloud can reach --
 * important for local dev, since this repo's backend isn't publicly
 * reachable.
 */
export function useVoiceSchedulingConversation(
  patient: { name: string; age?: number },
  mode: SessionMode = "full",
) {
  const [status, setStatus] = useState<CallStatus>("idle");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [facts, setFacts] = useState<ClinicalFact[]>([]);
  const [signals, setSignals] = useState<ConversationSignals | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [resolution, setResolution] = useState<Resolution | null>(null);
  // Same reasoning as useTextConversation.ts: read the server's trace rather
  // than reconstruct one client-side, so Session Review shows an identical
  // record regardless of which medium produced it.
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const [flags, setFlags] = useState<ReviewFlag[]>([]);

  const conversationRef = useRef<Conversation | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  const start = useCallback(
    async (agentId: string) => {
      setErrorMessage(null);
      setTranscript([]);
      setFacts([]);
      setSignals(null);
      setDecision(null);
      setResolution(null);
      sessionIdRef.current = null;
      setStatus("connecting");
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("This browser does not support microphone access.");
        }
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());

        const signedUrl = await fetchSignedUrl(agentId);
        // Created up front, same as text mode -- every tool call below needs
        // a session id to exist already, and there is no patient utterance
        // before the first one that would need it.
        sessionIdRef.current = await createSession(patient.name || "the patient", patient.age, mode);

        const conversation = await Conversation.startSession({
          signedUrl,
          connectionType: "websocket",
          dynamicVariables: { patient_first_name: patient.name || "the patient" },
          clientTools: {
            advance_scheduling: async (parameters: Record<string, unknown>) => {
              const sessionId = sessionIdRef.current;
              const message = String(parameters?.message ?? "").trim();
              if (!sessionId || !message) {
                return "Sorry, I'm having a little trouble on my end -- could you say that one more time?";
              }
              try {
                const result = await sendMessage(sessionId, message);
                setFacts(result.facts);
                if (result.signals) setSignals(result.signals);
                if (result.decision) setDecision(result.decision);
                setResolution(result.resolution);
                const state = await fetchSessionState(sessionId);
                setTrace(state.trace);
                setFlags(state.flags);
                return result.reply.text;
              } catch (error) {
                // eslint-disable-next-line no-console
                console.error("advance_scheduling tool call failed:", error);
                return "Sorry, I'm having a little trouble on my end -- could you say that one more time?";
              }
            },
          },
          onConnect: () => setStatus("connected"),
          onDisconnect: () => setStatus((current) => (current === "error" ? current : "ended")),
          onError: (message) => {
            setErrorMessage(message);
            setStatus("error");
          },
          // The tool call above is what actually drives the decision engine;
          // this only mirrors what got spoken into the transcript panel, same
          // granularity useDaphneConversation.ts uses for the legacy flow.
          onMessage: ({ message, role }) => {
            setTranscript((current) => [...current, { id: `entry-${nextEntryId++}`, role, text: message }]);
          },
        });
        conversationRef.current = conversation;
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
        setStatus("error");
      }
    },
    [patient.name, patient.age, mode],
  );

  const stop = useCallback(() => {
    void conversationRef.current?.endSession();
    conversationRef.current = null;
  }, []);

  const reset = useCallback(() => {
    void conversationRef.current?.endSession();
    conversationRef.current = null;
    sessionIdRef.current = null;
    setStatus("idle");
    setTranscript([]);
    setFacts([]);
    setSignals(null);
    setDecision(null);
    setResolution(null);
    setTrace([]);
    setFlags([]);
    setErrorMessage(null);
  }, []);

  const flag = useCallback(async (turn: number, note: string) => {
    if (!sessionIdRef.current) return;
    try {
      const result = await flagTurn(sessionIdRef.current, turn, note);
      setFlags(result.flags);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const exportScenario = useCallback(async () => {
    if (!sessionIdRef.current) return;
    try {
      const name = `captured_voice_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
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
    status,
    transcript,
    errorMessage,
    facts,
    signals,
    decision,
    resolution,
    trace,
    flags,
    start,
    stop,
    reset,
    flag,
    exportScenario,
  };
}
