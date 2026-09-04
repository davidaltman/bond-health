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
