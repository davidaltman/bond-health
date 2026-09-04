import type { AgentOption, SummarizeResponse, TranscriptEntry } from "./types";

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
