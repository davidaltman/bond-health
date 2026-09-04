import type { ClinicalFact, ConversationSignals } from "../types";

/**
 * Debug view of the clinical memory as it fills in mid-call.
 *
 * Two things it makes visible on purpose. Facts and signals are shown apart,
 * because a signal must never harden into a fact. And a stated negative renders
 * as an explicit "never" row rather than as nothing, since "the patient has
 * never been screened" and "we haven't asked yet" lead to opposite next moves.
 */

const STATUS_LABEL: Record<ClinicalFact["qualifiers"]["status"], string> = {
  active: "active",
  resolved: "resolved",
  never: "never",
  unknown: "unsure",
};

const READINESS_LABEL: Record<ConversationSignals["readiness"], string> = {
  not_raised: "not raised",
  exploring: "exploring",
  ambivalent: "ambivalent",
  ready: "ready",
  explicit_request: "explicitly asked",
};

function subjectLabel(subject: string): string {
  return subject === "self" ? "Patient" : subject.charAt(0).toUpperCase() + subject.slice(1);
}

export function LiveFactsPanel({
  facts,
  signals,
}: {
  facts: ClinicalFact[];
  signals: ConversationSignals | null;
}) {
  const grouped = new Map<string, ClinicalFact[]>();
  for (const fact of facts) {
    const key = subjectLabel(fact.subject);
    grouped.set(key, [...(grouped.get(key) ?? []), fact]);
  }

  return (
    <div className="panel live-facts-panel">
      <div className="panel-header">
        <h2>What Daphne knows</h2>
        <span className="live-facts-count">
          {facts.length} {facts.length === 1 ? "fact" : "facts"}
        </span>
      </div>

      {facts.length === 0 ? (
        <div className="transcript-empty">
          Nothing on file yet. Facts appear here as the patient states them.
        </div>
      ) : (
        <div className="live-facts-list">
          {[...grouped.entries()].map(([subject, subjectFacts]) => (
            <div key={subject} className="live-facts-group">
              <div className="live-facts-group-label">{subject}</div>
              {subjectFacts.map((fact) => (
                <div key={fact.id} className="live-fact" title={`"${fact.sourceQuote}"`}>
                  <div className="live-fact-head">
                    <span className="live-fact-value">{fact.value}</span>
                    <span className={`live-fact-status live-fact-status-${fact.qualifiers.status}`}>
                      {STATUS_LABEL[fact.qualifiers.status]}
                    </span>
                  </div>
                  <div className="live-fact-meta">
                    {fact.category.replace("_", " ")}
                    {fact.qualifiers.onsetAge != null ? ` · age ${fact.qualifiers.onsetAge}` : ""}
                    {fact.qualifiers.lastOccurred ? ` · ${fact.qualifiers.lastOccurred}` : ""}
                    {fact.confidence !== "high" ? ` · ${fact.confidence} confidence` : ""}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="live-signals">
        <div className="live-signals-label">
          How they sound <span className="live-signals-note">(not part of the record)</span>
        </div>
        {signals ? (
          <div className="live-signals-row">
            <span className="signal-chip">{signals.tone}</span>
            {signals.hesitation !== "none" ? (
              <span className="signal-chip">{signals.hesitation} hesitation</span>
            ) : null}
            <span className={`signal-chip signal-readiness-${signals.readiness}`}>
              {READINESS_LABEL[signals.readiness]}
            </span>
          </div>
        ) : (
          <div className="live-signals-row live-signals-empty">no reading yet</div>
        )}
      </div>
    </div>
  );
}
