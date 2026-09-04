import type {
  AgentOption,
  ExchangeResult,
  ReviewFlag,
  SummarizeResponse,
  TraceEvent,
  TranscriptEntry,
  TranscriptRole,
  TurnResult,
} from "./types";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://127.0.0.1:8790";

async function jsonOrThrow<T>(response: Response): Promise<T> {
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body ? body.error : text;
    throw new Error(String(message || `Request failed with ${response.status}`));
  }
  return body as T;
}

export async function fetchAgents(): Promise<{ agents: AgentOption[]; defaultAgentId: string }> {
  const response = await fetch(`${SERVER_URL}/api/agents`);
  return jsonOrThrow(response);
}

export async function fetchSignedUrl(agentId: string): Promise<string> {
  const response = await fetch(`${SERVER_URL}/api/signed-url?agentId=${encodeURIComponent(agentId)}`);
  const body = await jsonOrThrow<{ signedUrl: string }>(response);
  return body.signedUrl;
}

// --- live session memory ---------------------------------------------------
// Turns are posted as they arrive and the results land when they land. Nothing
// in the conversation ever waits on these -- see docs/phase-1-spec.md.

export async function createSession(patientName: string, patientAge?: number): Promise<string> {
  const response = await fetch(`${SERVER_URL}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patientName, patientAge }),
  });
  const body = await jsonOrThrow<{ sessionId: string }>(response);
  return body.sessionId;
}

export async function postTurn(
  sessionId: string,
  role: TranscriptRole,
  content: string,
): Promise<TurnResult> {
  const response = await fetch(`${SERVER_URL}/api/session/${sessionId}/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role, content }),
  });
  return jsonOrThrow<TurnResult>(response);
}

export async function sendMessage(sessionId: string, content: string): Promise<ExchangeResult> {
  const response = await fetch(`${SERVER_URL}/api/session/${sessionId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  return jsonOrThrow<ExchangeResult>(response);
}

export async function fetchSessionState(sessionId: string): Promise<{
  trace: TraceEvent[];
  flags: ReviewFlag[];
}> {
  const response = await fetch(`${SERVER_URL}/api/session/${sessionId}`);
  return jsonOrThrow(response);
}

export async function flagTurn(
  sessionId: string,
  turn: number,
  note: string,
): Promise<{ flags: ReviewFlag[] }> {
  const response = await fetch(`${SERVER_URL}/api/session/${sessionId}/flag`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ turn, note }),
  });
  return jsonOrThrow(response);
}

export async function fetchScenarioExport(sessionId: string, name: string): Promise<unknown> {
  const response = await fetch(
    `${SERVER_URL}/api/session/${sessionId}/scenario?name=${encodeURIComponent(name)}`,
  );
  return jsonOrThrow(response);
}

export async function summarizeTranscript(options: {
  patientName: string;
  patientAge?: number;
  transcript?: TranscriptEntry[];
  conversationId?: string;
}): Promise<SummarizeResponse> {
  const response = await fetch(`${SERVER_URL}/api/summarize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      patientName: options.patientName,
      patientAge: options.patientAge,
      conversationId: options.conversationId || undefined,
      transcript: options.transcript?.map((entry) => ({ role: entry.role, content: entry.text })),
    }),
  });
  return jsonOrThrow<SummarizeResponse>(response);
}
