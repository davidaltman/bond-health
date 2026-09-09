import type { ClinicalFact } from "../types";

/**
 * Debug view of the clinical memory as it fills in mid-call.
 *
 * A stated negative renders as an explicit "never" row rather than as
 * nothing, since "the patient has never been screened" and "we haven't
 * asked yet" lead to opposite next moves.
 */

const STATUS_LABEL: Record<ClinicalFact["qualifiers"]["status"], string> = {
  active: "active",
  resolved: "resolved",
  never: "never",
  unknown: "unsure",
};

function subjectLabel(subject: string): string {
  return subject === "self" ? "Patient" : subject.charAt(0).toUpperCase() + subject.slice(1);
}

export function LiveFactsPanel({ facts }: { facts: ClinicalFact[] }) {
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
                    {/* The attribute, not the value: three denials in one turn
                        all come back with a value like "none reported", which
                        renders as three identical rows. The canonical key is
                        what distinguishes them, and it is what the gates read. */}
                    <span className="live-fact-value">{fact.attribute}</span>
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
    </div>
  );
}
