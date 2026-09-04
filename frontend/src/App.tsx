import { useEffect, useMemo, useState } from "react";
import "./App.css";
import { AltmanAILogo } from "./components/AltmanAILogo";
import { CallControls } from "./components/CallControls";
import { TranscriptPanel } from "./components/TranscriptPanel";
import { LiveFactsPanel } from "./components/LiveFactsPanel";
import { SummaryPanel } from "./components/SummaryPanel";
import { useDaphneConversation } from "./useDaphneConversation";
import { fetchAgents, summarizeTranscript } from "./api";
import type { AgentOption, SummarizeResponse } from "./types";

export default function App() {
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [patientName, setPatientName] = useState("David");
  const [patientAge, setPatientAge] = useState(53);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [summary, setSummary] = useState<SummarizeResponse | null>(null);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [summarizeError, setSummarizeError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState("");

  const dynamicVariables = useMemo(
    () => ({
      patient_first_name: patientName || "the patient",
      patient_id: "demo-patient-001",
      agent_name: "Daphne",
      conversation_session_id: "demo-session-001",
    }),
    [patientName],
  );

  const patient = useMemo(
    () => ({ name: patientName || "the patient", age: patientAge }),
    [patientName, patientAge],
  );

  const { status, transcript, errorMessage, facts, signals, start, stop, loadHistoricalTranscript } =
    useDaphneConversation(dynamicVariables, patient);

  useEffect(() => {
    fetchAgents()
      .then(({ agents: loaded, defaultAgentId }) => {
        setAgents(loaded);
        setSelectedAgentId(defaultAgentId);
      })
      .catch((error) => setLoadError(error instanceof Error ? error.message : String(error)));
  }, []);

  function handleStart() {
    const agent = agents.find((candidate) => candidate.id === selectedAgentId);
    if (!agent) {
      setLoadError(`Unknown agent "${selectedAgentId}" -- reload the page and try again.`);
      return;
    }
    setSummary(null);
    setSummarizeError(null);
    void start(agent.agentId);
  }

  async function handleGenerateSummary() {
    setIsSummarizing(true);
    setSummarizeError(null);
    try {
      const trimmedConversationId = conversationId.trim();
      const result = await summarizeTranscript({
        patientName: patientName || "the patient",
        patientAge,
        transcript,
        conversationId: trimmedConversationId || undefined,
      });
      setSummary(result);
      if (trimmedConversationId) {
        loadHistoricalTranscript(result.transcript);
        if (result.patientName) setPatientName(result.patientName);
      }
    } catch (error) {
      setSummarizeError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSummarizing(false);
    }
  }

  const canGenerateSummary =
    (transcript.length > 0 || conversationId.trim().length > 0) && status !== "connecting";

  return (
    <div className="app-shell">
      <header className="app-header">
        <AltmanAILogo size={32} />
        <div className="app-header-subtitle">Voice health-intake demo</div>
      </header>

      {loadError ? <div className="error-banner app-level-error">{loadError}</div> : null}

      <main className="app-main">
        <div className="app-column app-column-left">
          <CallControls
            agents={agents}
            selectedAgentId={selectedAgentId}
            onSelectAgent={setSelectedAgentId}
            patientName={patientName}
            onPatientNameChange={setPatientName}
            patientAge={patientAge}
            onPatientAgeChange={setPatientAge}
            status={status}
            onStart={handleStart}
            onStop={stop}
          />
          <LiveFactsPanel facts={facts} signals={signals} />
        </div>

        <div className="app-column app-column-center">
          <TranscriptPanel status={status} transcript={transcript} errorMessage={errorMessage} />
        </div>

        <div className="app-column app-column-right">
          <SummaryPanel
            canGenerate={canGenerateSummary}
            isGenerating={isSummarizing}
            result={summary}
            errorMessage={summarizeError}
            conversationId={conversationId}
            onConversationIdChange={setConversationId}
            onGenerate={() => void handleGenerateSummary()}
          />
        </div>
      </main>
    </div>
  );
}
