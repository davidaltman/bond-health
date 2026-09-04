export interface AgentOption {
  id: string;
  agentId: string;
  label: string;
  description: string;
}

export type TranscriptRole = "agent" | "user";

export interface TranscriptEntry {
  id: string;
  role: TranscriptRole;
  text: string;
}

export type CallStatus = "idle" | "connecting" | "connected" | "ended" | "error";

export interface HealthEvent {
  person: string;
  category: "surgery" | "medication" | "condition" | "symptom" | "family_history";
  subcategory: string | null;
  description: string;
  approx_age: number | null;
  still_living: boolean | null;
  confidence: "high" | "medium" | "low";
  source_quote: string;
  conflict_with_logged_fact: boolean;
  conflict_note: string | null;
}

export interface SummarizeSource {
  conversationId: string;
  agentName: string | null;
  status: string | null;
}

export interface SummarizeTranscriptTurn {
  role: TranscriptRole;
  content: string;
}

// One point plotted on the shared age axis. Only events with a known
// approx_age make it into a TimelineRow -- there's no x-position to place
// them at otherwise (see server/src/timeline.ts buildAgeTimeline).
export interface TimelineEventPoint {
  age: number;
  description: string;
  category: HealthEvent["category"];
  subcategory: string | null;
  stillLiving: boolean | null;
}

export interface TimelineRow {
  person: string;
  label: string;
  events: TimelineEventPoint[];
}

export interface AgeTimelineChart {
  title: string;
  minAge: number;
  maxAge: number;
  rows: TimelineRow[];
}

export type FollowUpWhen = "few_weeks" | "next_visit" | "no_visit" | "next_call";

export interface FollowUpItem {
  finding: string;
  action: string;
  who: string;
  when: FollowUpWhen;
  sources: string;
  authoredBy: "guideline_table" | "pattern_template" | "deterministic_check";
}

export interface SummarizeResponse {
  sessionSummary: string;
  healthEvents: HealthEvent[];
  timelineChart: AgeTimelineChart;
  followUps: FollowUpItem[];
  patientName: string;
  source: SummarizeSource | null;
  transcript: SummarizeTranscriptTurn[];
}

// --- live session memory (Phase 1) -----------------------------------------
// Mirrors server/src/ledger.ts. `status: "never"` is a stated negative and is
// deliberately different from a fact simply being absent.

export type FactStatus = "active" | "resolved" | "never" | "unknown";
export type FactState = "asserted" | "confirmed" | "contradicted" | "superseded";

export interface ClinicalFact {
  id: string;
  subject: string;
  category: "condition" | "symptom" | "medication" | "procedure" | "screening" | "family_history" | "allergy";
  attribute: string;
  value: string;
  qualifiers: {
    onsetAge: number | null;
    lastOccurred: string | null;
    status: FactStatus;
  };
  confidence: "high" | "medium" | "low";
  provenance: "patient_stated" | "document_upload";
  sourceQuote: string;
  firstTurn: number;
  lastTurn: number;
  state: FactState;
  supersededBy: string | null;
  contradictionNote: string | null;
}

export interface ConversationSignals {
  turn: number;
  tone: "neutral" | "worried" | "frustrated" | "embarrassed" | "rushed";
  hesitation: "none" | "mild" | "strong";
  readiness: "not_raised" | "exploring" | "ambivalent" | "ready" | "explicit_request";
  verbosity: "brief" | "normal" | "detailed";
  requestType: "none" | "information" | "action" | "clinical_judgment";
  sensitiveTopics: string[];
}

export type Outcome = "ACT" | "ASK" | "STOP" | "HANDOFF";

export interface Decision {
  turn: number;
  outcome: Outcome;
  gate: string;
  reason: string;
  missingSlot: string | null;
  say: string;
  evidence: string[];
  recommendation: {
    indicated: boolean;
    startAge: number;
    riskTier: "average" | "elevated_family_history";
    bookWithinDays: number;
    rationale: string;
  } | null;
}

export type Resolution =
  | {
      status: "booked";
      booking: {
        confirmationId: string;
        slot: { clinic: string; startsAt: string; daysOut: number };
        prepInstructions: string[];
      };
    }
  | { status: "waitlisted"; waitlistId: string; reason: string; nextStep: string };

export interface TurnResult {
  turnIndex: number;
  applied: Array<{
    outcome: "added" | "confirmed" | "refined" | "contradicted" | "coerced_to_merge" | "rejected";
    factId: string | null;
    proposedOp: string;
    detail: string;
  }>;
  facts: ClinicalFact[];
  signals: ConversationSignals | null;
  decision: Decision | null;
  resolution: Resolution | null;
}

export interface TraceEvent {
  turn: number;
  at: string;
  kind:
    | "turn_received"
    | "operations_applied"
    | "extraction_failed"
    | "extraction_skipped"
    | "decision"
    | "resolution";
  detail: string;
  decision?: Decision;
}

export interface ReviewFlag {
  turn: number;
  note: string;
  expectedOutcome: string | null;
  at: string;
}

export interface ComposedReply {
  text: string;
  acknowledgment: string;
  substance: string;
  guardTripped: string | null;
}

export interface ExchangeResult extends TurnResult {
  reply: ComposedReply;
}
