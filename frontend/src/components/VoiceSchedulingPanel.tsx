import { useEffect, useRef } from "react";
import type { CallStatus, SessionMode, TranscriptEntry } from "../types";

const STATUS_LABEL: Record<CallStatus, string> = {
  idle: "Not started",
  connecting: "Connecting…",
  connected: "Live",
  ended: "Call ended",
  error: "Error",
};

/**
 * Voice, driven by the same decision engine as ChatPanel -- see
 * useVoiceSchedulingConversation.ts. Deliberately its own panel rather than
 * folded into CallControls/TranscriptPanel: those back the legacy 4-stage
 * history-taking demo, which has no relationship to SessionMode or the
 * scheduling gates, and mixing the two would make it unclear which "Start
 * call" button actually reaches the decision engine.
 */
export function VoiceSchedulingPanel({
  status,
  transcript,
  errorMessage,
  mode,
  onStart,
  onStop,
  onReset,
}: {
  status: CallStatus;
  transcript: TranscriptEntry[];
  errorMessage: string | null;
  mode: SessionMode;
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const isLive = status === "connecting" || status === "connected";

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [transcript.length]);

  return (
    <div className="panel transcript-panel">
      <div className="panel-header">
        <h2>Conversation</h2>
        <span className="current-badge">The decision engine — speak here</span>
        <span className="mode-badge">{mode === "scheduling_only" ? "Scheduling only" : "Full intake"}</span>
        <span className={`status-pill status-${status}`}>
          <span className="status-dot" />
          {STATUS_LABEL[status]}
        </span>
      </div>

      <p className="legacy-note">
        Each turn round-trips through the same extraction + decision pass text mode uses, so expect
        a beat of silence (1&ndash;3s) after you speak before Daphne replies &mdash; that's the
        engine actually deciding, not lag.
      </p>

      {errorMessage && <div className="error-banner">{errorMessage}</div>}

      <div className="call-buttons">
        <button type="button" className="primary-button" onClick={onStart} disabled={isLive}>
          {status === "connecting" ? "Connecting…" : "Start call"}
        </button>
        <button
          type="button"
          className="danger-button"
          onClick={onStop}
          disabled={status !== "connected" && status !== "connecting"}
        >
          Stop call
        </button>
        <button type="button" className="chat-reset" onClick={onReset} disabled={status === "idle" && transcript.length === 0}>
          New session
        </button>
      </div>

      <div className="transcript-scroll" ref={scrollRef}>
        {transcript.length === 0 && status !== "error" ? (
          <div className="transcript-empty">
            {status === "idle"
              ? mode === "scheduling_only"
                ? "Press “Start call” and allow microphone access, then try “I need to get a colonoscopy scheduled, my doctor already referred me.”"
                : "Press “Start call” and allow microphone access, then try “My doctor keeps bringing up a colonoscopy and I keep putting it off.”"
              : "Waiting for the conversation to begin…"}
          </div>
        ) : null}
        {transcript.map((entry) => (
          <div key={entry.id} className={`transcript-turn transcript-turn-${entry.role}`}>
            <div className="transcript-turn-label">{entry.role === "agent" ? "Daphne" : "Patient"}</div>
            <div className="transcript-turn-text">{entry.text}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
