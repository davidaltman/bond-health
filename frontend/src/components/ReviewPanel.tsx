import { useState } from "react";
import type { TraceEvent } from "../types";

/**
 * Session Review: what Daphne knew, what she decided, and why — per turn.
 *
 * This answers "did this go well?" while it is still going, which is a
 * different question from "how do we know it goes well in general". A
 * transcript can't answer it: "I'd rather not book that yet" reads the same
 * whether the agent respected hesitation or simply failed to realize it could
 * act. Showing the gate makes those distinguishable at a glance.
 *
 * Flagging a turn is the input to the offline half — a flagged session exports
 * as a scenario file the eval suite runs.
 */

const KIND_LABEL: Record<TraceEvent["kind"], string> = {
  turn_received: "turn",
  operations_applied: "ledger",
  extraction_failed: "extraction failed",
  extraction_skipped: "skipped",
  decision: "decision",
  resolution: "resolution",
};

export function ReviewPanel({
  trace,
  flaggedTurns,
  onFlag,
  onExport,
  busy,
}: {
  trace: TraceEvent[];
  flaggedTurns: number[];
  onFlag: (turn: number, note: string) => void;
  onExport: () => void;
  busy: boolean;
}) {
  const [flagging, setFlagging] = useState<number | null>(null);
  const [note, setNote] = useState("");

  // Only turns that produced a decision are worth reviewing; the rest is
  // bookkeeping.
  const byTurn = new Map<number, TraceEvent[]>();
  for (const event of trace) {
    byTurn.set(event.turn, [...(byTurn.get(event.turn) ?? []), event]);
  }
  const reviewable = [...byTurn.entries()]
    .filter(([, events]) => events.some((event) => event.kind === "decision"))
    .sort((a, b) => b[0] - a[0]);

  return (
    <div className="panel review-panel">
      <div className="panel-header">
        <h2>Session review</h2>
        <button type="button" className="chat-reset" onClick={onExport} disabled={busy || !trace.length}>
          Export as eval case
        </button>
      </div>

      {reviewable.length === 0 ? (
        <div className="transcript-empty">
          Nothing to review yet. Each turn's gate and reasoning shows up here as it happens.
        </div>
      ) : (
        <div className="review-list">
          {reviewable.map(([turn, events]) => {
            const decision = events.find((event) => event.kind === "decision")?.decision;
            const ledger = events.find((event) => event.kind === "operations_applied");
            const failure = events.find((event) => event.kind === "extraction_failed");
            const said = events.find((event) => event.kind === "turn_received")?.detail ?? "";
            const isFlagged = flaggedTurns.includes(turn);

            return (
              <div key={turn} className={isFlagged ? "review-turn review-turn-flagged" : "review-turn"}>
                <div className="review-turn-head">
                  <span className="review-turn-index">turn {turn}</span>
                  {decision ? (
                    <span className={`outcome-pill outcome-${decision.outcome}`}>{decision.outcome}</span>
                  ) : null}
                  <button
                    type="button"
                    className="review-flag-button"
                    onClick={() => {
                      setFlagging(flagging === turn ? null : turn);
                      setNote("");
                    }}
                  >
                    {isFlagged ? "flagged" : "flag"}
                  </button>
                </div>

                <div className="review-said">{said.replace(/^user: /, "")}</div>

                {decision ? (
                  <div className="review-line">
                    <span className="decision-gate">{decision.gate}</span>
                    {decision.reason}
                  </div>
                ) : null}
                {ledger ? <div className="review-line review-line-muted">{ledger.detail}</div> : null}
                {failure ? (
                  <div className="review-line review-line-error">extraction failed: {failure.detail}</div>
                ) : null}

                {flagging === turn ? (
                  <form
                    className="review-flag-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      onFlag(turn, note);
                      setFlagging(null);
                      setNote("");
                    }}
                  >
                    <input
                      className="chat-input"
                      autoFocus
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      placeholder="What went wrong here?"
                    />
                    <button type="submit" className="button-primary" disabled={!note.trim()}>
                      Flag
                    </button>
                  </form>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
