import { useEffect, useMemo, useState } from "react";
import "./App.css";
import { AltmanAILogo } from "./components/AltmanAILogo";
import { CallControls } from "./components/CallControls";
import { TranscriptPanel } from "./components/TranscriptPanel";
import { ChatPanel } from "./components/ChatPanel";
import { VoiceSchedulingPanel } from "./components/VoiceSchedulingPanel";
import { LiveFactsPanel } from "./components/LiveFactsPanel";
import { DecisionPanel } from "./components/DecisionPanel";
import { ReviewPanel } from "./components/ReviewPanel";
import { SummaryPanel } from "./components/SummaryPanel";
import { useDaphneConversation } from "./useDaphneConversation";
import { useTextConversation } from "./useTextConversation";
import { useVoiceSchedulingConversation } from "./useVoiceSchedulingConversation";
import { fetchAgents, summarizeTranscript } from "./api";
import type { AgentOption, SessionMode, SummarizeResponse } from "./types";

// "voice_legacy" is the original 4-stage history-taking demo (observer
// only -- see useDaphneConversation.ts). It talks from its own
// ElevenLabs-authored prompt with no backend round trip per turn, so it has
// none of the decision engine's per-turn extraction/decide latency -- which
// is exactly what you want for history-taking, and exactly what you don't
// want if you actually need scheduling. "voice_scheduling" (also labeled
// "Voice") is the decision-engine-driven agent that can actually book slots,
// but pays that latency cost per turn.
//
// Rather than exposing both as separate pills (which meant an extra click,
// and easy to leave on the wrong one), there is a single "Voice" button
// whose underlying implementation is picked by sessionMode: "Full intake"
// -> voice_legacy, "Scheduling only" -> voice_scheduling. Full intake never
// needed to schedule anything, and scheduling-only never needed intake's
// history-taking flow, so the mapping is 1:1 and there's no scenario where
// you'd want the other implementation under a given session mode. See
// handleSessionModeChange for what happens when you flip session mode while
// already on Voice.
type Medium = "text" | "voice_legacy" | "voice_scheduling";

export default function App() {
  // Text is the default. All four combinations (text/voice x full/scheduling)
  // are wired up below regardless of which is currently selected -- see the
  // Medium comment above for how "Voice" resolves to a specific medium.
  const [medium, setMedium] = useState<Medium>("text");
  // Isolated on purpose: a session started in one mode can't turn into the
  // other mid-conversation (see decide.ts's SessionMode and Session.mode).
  // Switching this always starts a fresh session rather than reinterpreting
  // the current one.
  const [sessionMode, setSessionMode] = useState<SessionMode>("full");
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [schedulingVoiceAgentId, setSchedulingVoiceAgentId] = useState<string>("");
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

  const {
    status,
    transcript,
    errorMessage,
    facts,
    decision,
    resolution,
    start,
    stop,
    loadHistoricalTranscript,
  } = useDaphneConversation(dynamicVariables, patient);

  const text = useTextConversation(patient, sessionMode);
  const voiceScheduling = useVoiceSchedulingConversation(patient, sessionMode);

  function handleSessionModeChange(next: SessionMode) {
    if (next === sessionMode) return;
    setSessionMode(next);
    // A session's mode is fixed at creation (see Session.mode) -- there is no
    // well-defined way to turn a scheduling-only session into a full-intake
    // one or back, so switching the toggle starts clean rather than trying to
    // carry a half-finished conversation across the boundary. Both
    // decision-engine mediums share this toggle, so both get reset.
    text.reset();
    voiceScheduling.reset();
    // If you're on Voice, stay on Voice, but swap which implementation it
    // means: Full intake's Voice is always voice_legacy, Scheduling only's
    // Voice is always voice_scheduling. Text needs no swap -- the same
    // decision-engine text hook serves both modes (see useTextConversation).
    if (medium !== "text") setMedium(next === "full" ? "voice_legacy" : "voice_scheduling");
  }

  const activeFacts = medium === "text" ? text.facts : medium === "voice_scheduling" ? voiceScheduling.facts : facts;
  const activeDecision =
    medium === "text" ? text.decision : medium === "voice_scheduling" ? voiceScheduling.decision : decision;
  const activeResolution =
    medium === "text" ? text.resolution : medium === "voice_scheduling" ? voiceScheduling.resolution : resolution;

  useEffect(() => {
    fetchAgents()
      .then(({ agents: loaded, defaultAgentId, schedulingVoiceAgentId: schedulingId }) => {
        setAgents(loaded);
        setSelectedAgentId(defaultAgentId);
        setSchedulingVoiceAgentId(schedulingId);
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
        <div className="app-header-subtitle">Health intake, from history-taking to resolution</div>
        <div className="medium-toggle" title="Fixed per session -- switching starts a new one">
          <button
            type="button"
            className={sessionMode === "full" ? "medium-option medium-option-active" : "medium-option"}
            onClick={() => handleSessionModeChange("full")}
          >
            Full intake
          </button>
          <button
            type="button"
            className={sessionMode === "scheduling_only" ? "medium-option medium-option-active" : "medium-option"}
            onClick={() => handleSessionModeChange("scheduling_only")}
          >
            Scheduling only
          </button>
        </div>
        <div className="medium-toggle" title="Voice uses the legacy agent under Full intake, the scheduling agent under Scheduling only">
          <button
            type="button"
            className={medium === "text" ? "medium-option medium-option-active" : "medium-option"}
            onClick={() => setMedium("text")}
          >
            Text
          </button>
          <button
            type="button"
            className={medium !== "text" ? "medium-option medium-option-active" : "medium-option"}
            onClick={() => setMedium(sessionMode === "full" ? "voice_legacy" : "voice_scheduling")}
          >
            Voice
          </button>
        </div>
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
            showLegacyControls={medium === "voice_legacy"}
          />
          <LiveFactsPanel facts={activeFacts} />
        </div>

        <div className="app-column app-column-center">
          {medium === "text" ? (
            <ChatPanel
              transcript={text.transcript}
              isThinking={text.isThinking}
              errorMessage={text.errorMessage}
              mode={sessionMode}
              onSend={(message) => void text.send(message)}
              onReset={text.reset}
            />
          ) : medium === "voice_scheduling" ? (
            <VoiceSchedulingPanel
              status={voiceScheduling.status}
              transcript={voiceScheduling.transcript}
              errorMessage={voiceScheduling.errorMessage}
              mode={sessionMode}
              onStart={() => void voiceScheduling.start(schedulingVoiceAgentId)}
              onStop={voiceScheduling.stop}
              onReset={voiceScheduling.reset}
            />
          ) : (
            <TranscriptPanel status={status} transcript={transcript} errorMessage={errorMessage} />
          )}
          {/* Only meaningful under Scheduling only: that's the one mode where the
              decision engine actually drives what gets said. Under Full intake,
              voice_legacy never consults it at all (it's a pure ElevenLabs-scripted
              observer -- see useDaphneConversation.ts), so a HANDOFF/"stuck gate"
              badge there describes nothing that really happened on the call; even
              under Full intake + Text, intake isn't meant to expose booking-gate
              plumbing to begin with. */}
          {sessionMode === "scheduling_only" ? (
            <DecisionPanel decision={activeDecision} resolution={activeResolution} />
          ) : null}
          {medium === "text" || medium === "voice_scheduling" ? (
            <ReviewPanel
              trace={medium === "text" ? text.trace : voiceScheduling.trace}
              flaggedTurns={(medium === "text" ? text.flags : voiceScheduling.flags).map((entry) => entry.turn)}
              onFlag={(turn, note) =>
                void (medium === "text" ? text.flag(turn, note) : voiceScheduling.flag(turn, note))
              }
              onExport={() => void (medium === "text" ? text.exportScenario() : voiceScheduling.exportScenario())}
              busy={medium === "text" ? text.isThinking : voiceScheduling.status === "connecting"}
            />
          ) : null}
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
