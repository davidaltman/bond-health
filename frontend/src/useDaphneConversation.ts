import { useCallback, useRef, useState } from "react";
import { Conversation } from "@elevenlabs/client";
import { fetchSignedUrl } from "./api";
import type { CallStatus, SummarizeTranscriptTurn, TranscriptEntry } from "./types";

let nextEntryId = 0;

/**
 * Thin wrapper around @elevenlabs/client's Conversation.startSession, mirroring
 * the pattern used by run_elevenlabs_conversation_replay_multitenant.mjs
 * (../../../../utils/) and the collections webapp's AgentConversationPanel --
 * but talking to OUR backend for the signed URL (see server/src/index.ts)
 * instead of ElevenLabs directly, so the API key never reaches the browser.
 */
export function useDaphneConversation(dynamicVariables: Record<string, string>) {
  const [status, setStatus] = useState<CallStatus>("idle");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const conversationRef = useRef<Conversation | null>(null);

  const start = useCallback(
    async (agentId: string) => {
      setErrorMessage(null);
      setTranscript([]);
      setStatus("connecting");
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("This browser does not support microphone access.");
        }
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());

        const signedUrl = await fetchSignedUrl(agentId);
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
          onMessage: ({ message, role }) => {
            setTranscript((current) => [
              ...current,
              { id: `entry-${nextEntryId++}`, role, text: message },
            ]);
          },
        });
        conversationRef.current = conversation;
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
        setStatus("error");
      }
    },
    [dynamicVariables],
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
  }, []);

  return { status, transcript, errorMessage, start, stop, loadHistoricalTranscript };
}
