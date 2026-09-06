import type { AgentOption, CallStatus } from "../types";

export function CallControls({
  agents,
  selectedAgentId,
  onSelectAgent,
  patientName,
  onPatientNameChange,
  patientAge,
  onPatientAgeChange,
  status,
  onStart,
  onStop,
  showLegacyControls,
}: {
  agents: AgentOption[];
  selectedAgentId: string;
  onSelectAgent: (id: string) => void;
  patientName: string;
  onPatientNameChange: (value: string) => void;
  patientAge: number;
  onPatientAgeChange: (value: number) => void;
  status: CallStatus;
  onStart: () => void;
  onStop: () => void;
  /** The agent picker and Start/Stop buttons below only mean anything for
   *  voice_legacy (Full intake's Voice) -- Text and Scheduling only's Voice
   *  each drive their own session from their own center-column panel.
   *  Patient identity stays visible in every mode, since all of them read it
   *  from here. */
  showLegacyControls: boolean;
}) {
  const isLive = status === "connecting" || status === "connected";

  return (
    <div className="panel controls-panel">
      <div className="panel-header">
        <h2>{showLegacyControls ? "Call setup" : "Patient"}</h2>
      </div>

      <div className="field-row">
        <label className="field">
          <span>Patient first name</span>
          <input
            type="text"
            value={patientName}
            onChange={(event) => onPatientNameChange(event.target.value)}
            disabled={isLive}
            placeholder="David"
          />
        </label>
        <label className="field field-age">
          <span>Age</span>
          <input
            type="number"
            min={1}
            max={120}
            value={patientAge}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next)) onPatientAgeChange(next);
            }}
            disabled={isLive}
          />
        </label>
      </div>

      {showLegacyControls ? (
        <>
          <label className="field">
            <span>Start on agent</span>
            <select value={selectedAgentId} disabled={isLive} onChange={(event) => onSelectAgent(event.target.value)}>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.label}
                </option>
              ))}
            </select>
            <span className="field-hint">
              {agents.find((agent) => agent.id === selectedAgentId)?.description}
            </span>
          </label>

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
          </div>

          <p className="controls-note">
            The 4 Daphne stages hand off to each other automatically once the call starts &mdash;
            pick a stage above only if you want to jump in partway through for testing.
          </p>
        </>
      ) : null}
    </div>
  );
}
