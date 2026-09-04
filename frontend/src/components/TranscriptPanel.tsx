import { useEffect, useRef } from "react";
import type { CallStatus, TranscriptEntry } from "../types";

const STATUS_LABEL: Record<CallStatus, string> = {
  idle: "Not started",
  connecting: "Connecting…",
  connected: "Live",
  ended: "Call ended",
  error: "Error",
};

export function TranscriptPanel({
  status,
  transcript,
  errorMessage,
}: {
  status: CallStatus;
  transcript: TranscriptEntry[];
  errorMessage: string | null;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [transcript.length]);

  return (
    <div className="panel transcript-panel">
      <div className="panel-header">
        <h2>Live transcript</h2>
        <span className={`status-pill status-${status}`}>
          <span className="status-dot" />
          {STATUS_LABEL[status]}
        </span>
      </div>

      {errorMessage && <div className="error-banner">{errorMessage}</div>}

      <div className="transcript-scroll" ref={scrollRef}>
        {transcript.length === 0 && status !== "error" ? (
          <div className="transcript-empty">
            {status === "idle"
              ? "Press \u201cStart call\u201d and allow microphone access to begin."
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
