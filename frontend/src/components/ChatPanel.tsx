import { useEffect, useRef, useState } from "react";
import type { SessionMode, TranscriptEntry } from "../types";

/**
 * The text conversation. Every Daphne line here came out of the decision
 * engine, which is what makes this the honest demo path: what you read is what
 * the gates produced, not a separate model narrating alongside them.
 */
export function ChatPanel({
  transcript,
  isThinking,
  errorMessage,
  mode,
  onSend,
  onReset,
}: {
  transcript: TranscriptEntry[];
  isThinking: boolean;
  errorMessage: string | null;
  mode: SessionMode;
  onSend: (text: string) => void;
  onReset: () => void;
}) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [transcript.length, isThinking]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    onSend(draft);
    setDraft("");
  }

  return (
    <div className="panel transcript-panel">
      <div className="panel-header">
        <h2>Conversation</h2>
        <span className="current-badge">The decision engine — type here</span>
        <span className="mode-badge">{mode === "scheduling_only" ? "Scheduling only" : "Full intake"}</span>
        <button type="button" className="chat-reset" onClick={onReset} disabled={transcript.length === 0}>
          New session
        </button>
      </div>

      {errorMessage && <div className="error-banner">{errorMessage}</div>}

      <div className="transcript-scroll" ref={scrollRef}>
        {transcript.length === 0 ? (
          <div className="transcript-empty">
            {mode === "scheduling_only" ? (
              <>
                Skips history questions and goes straight to booking. Say something to Daphne. Try
                “I need to get a colonoscopy scheduled, my doctor already referred me.”
              </>
            ) : (
              <>
                Say something to Daphne. Try “My doctor keeps bringing up a colonoscopy and I keep
                putting it off.”
              </>
            )}
          </div>
        ) : null}
        {transcript.map((entry) => (
          <div key={entry.id} className={`transcript-turn transcript-turn-${entry.role}`}>
            <div className="transcript-turn-label">{entry.role === "agent" ? "Daphne" : "Patient"}</div>
            <div className="transcript-turn-text">{entry.text}</div>
          </div>
        ))}
        {isThinking ? (
          <div className="transcript-turn transcript-turn-agent">
            <div className="transcript-turn-label">Daphne</div>
            <div className="transcript-turn-text chat-thinking">deciding…</div>
          </div>
        ) : null}
      </div>

      <form className="chat-form" onSubmit={submit}>
        <input
          className="chat-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Type as the patient…"
          disabled={isThinking}
        />
        <button type="submit" className="button-primary" disabled={isThinking || !draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
