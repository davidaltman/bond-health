import type { Decision, Resolution } from "../types";

/**
 * What the agent decided this turn, and why.
 *
 * The reason line is the part worth having on screen. Any agent can produce an
 * answer; this one has to show which gate produced it, so a reviewer can tell
 * "declined to book because the patient is ambivalent" apart from "declined to
 * book because it didn't realize it could" -- outcomes that look identical in a
 * transcript and mean opposite things about whether the system is working.
 */

const OUTCOME_BLURB: Record<Decision["outcome"], string> = {
  ACT: "Preconditions met — acting",
  ASK: "Missing something — asking",
  STOP: "Out of scope — declining",
  HANDOFF: "Routing to a human",
};

export function DecisionPanel({
  decision,
  resolution,
}: {
  decision: Decision | null;
  resolution: Resolution | null;
}) {
  return (
    <div className="panel decision-panel">
      <div className="panel-header">
        <h2>Decision</h2>
        {decision ? (
          <span className={`outcome-pill outcome-${decision.outcome}`}>{decision.outcome}</span>
        ) : null}
      </div>

      {!decision ? (
        <div className="transcript-empty">No decision yet — this updates after each patient turn.</div>
      ) : (
        <>
          <div className="decision-blurb">{OUTCOME_BLURB[decision.outcome]}</div>
          <div className="decision-reason">
            <span className="decision-gate">{decision.gate} gate</span>
            {decision.reason}
          </div>
          {decision.recommendation ? (
            <div className="decision-guideline">
              <span className="decision-guideline-label">Guideline</span>
              {decision.recommendation.rationale}
            </div>
          ) : null}
        </>
      )}

      {resolution ? (
        <div className={`resolution resolution-${resolution.status}`}>
          {resolution.status === "booked" ? (
            <>
              <div className="resolution-title">Booked · {resolution.booking.confirmationId}</div>
              <div className="resolution-detail">
                {resolution.booking.slot.clinic}, {resolution.booking.slot.daysOut} days out
              </div>
              <ul className="resolution-prep">
                {resolution.booking.prepInstructions.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <div className="resolution-title">Waitlisted · {resolution.waitlistId}</div>
              <div className="resolution-detail">{resolution.reason}</div>
              <div className="resolution-detail">{resolution.nextStep}</div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
