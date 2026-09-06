import type { FollowUpItem, FollowUpWhen, SummarizeResponse } from "../types";
import { TimelineChart } from "./TimelineChart";

const WHEN_LABEL: Record<FollowUpWhen, string> = {
  few_weeks: "Within a few weeks",
  next_visit: "At your next routine visit",
  no_visit: "No visit needed",
  next_call: "On your next call with Daphne",
};

const SOON_WHENS: FollowUpWhen[] = ["few_weeks", "next_visit"];

function FollowUpRow({ item }: { item: FollowUpItem }) {
  return (
    <li className="followup-item">
      <div className="followup-item-header">
        <span className={`when-tag when-${item.when}`}>{WHEN_LABEL[item.when]}</span>
        <strong>{item.finding}</strong>
      </div>
      <p className="followup-action">{item.action}</p>
      <div className="followup-meta">
        <span>Who: {item.who}</span>
        <span>Based on: {item.sources}</span>
      </div>
    </li>
  );
}

export function SummaryPanel({
  canGenerate,
  isGenerating,
  result,
  errorMessage,
  conversationId,
  onConversationIdChange,
  onGenerate,
}: {
  canGenerate: boolean;
  isGenerating: boolean;
  result: SummarizeResponse | null;
  errorMessage: string | null;
  conversationId: string;
  onConversationIdChange: (value: string) => void;
  onGenerate: () => void;
}) {
  const hasConversationId = conversationId.trim().length > 0;

  return (
    <div className="panel summary-panel">
      <div className="panel-header">
        <h2>Summary &amp; health timeline</h2>
      </div>
      <div className="panel-header">
        <span />
        <button type="button" className="secondary-button" disabled={!canGenerate || isGenerating} onClick={onGenerate}>
          {isGenerating ? "Generating…" : result ? "Regenerate" : hasConversationId ? "Generate from conversation" : "Generate from call"}
        </button>
      </div>

      <label className="field">
        <span>Or pull a past conversation by id</span>
        <input
          type="text"
          value={conversationId}
          onChange={(event) => onConversationIdChange(event.target.value)}
          disabled={isGenerating}
          placeholder="conv_..."
        />
      </label>

      {errorMessage && <div className="error-banner">{errorMessage}</div>}

      {!result && !isGenerating ? (
        <div className="transcript-empty">
          End the call (or paste a conversation id above), then click &ldquo;Generate&rdquo; to extract a summary
          and timeline.
        </div>
      ) : null}

      {isGenerating ? <div className="transcript-empty">Extracting health events from the call…</div> : null}

      {result ? (
        <div className="summary-content">
          <p className="summary-text">{result.sessionSummary}</p>
          <TimelineChart chart={result.timelineChart} />
          <details className="events-details">
            <summary>{result.healthEvents.length} structured health event(s)</summary>
            <ul className="events-list">
              {result.healthEvents.map((event, index) => (
                <li key={index}>
                  <strong>{event.person}</strong> &mdash; {event.description}
                  {event.approx_age != null ? ` (age ${event.approx_age})` : ""}
                  <span className={`confidence-tag confidence-${event.confidence}`}>{event.confidence}</span>
                </li>
              ))}
            </ul>
          </details>

          {result.followUps.length > 0 ? (
            <details className="events-details followups-details" open={result.followUps.some((item) => SOON_WHENS.includes(item.when))}>
              <summary>Insights &amp; actions ({result.followUps.length})</summary>
              <ul className="followup-list">
                {result.followUps.map((item, index) => (
                  <FollowUpRow key={index} item={item} />
                ))}
              </ul>
              <p className="followup-disclaimer">
                These are discussion prompts for your care team, not a diagnosis or treatment plan.
              </p>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
