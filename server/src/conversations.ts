/**
 * Fetch a finished ElevenLabs conversation by id and convert it into the
 * same TranscriptTurn[] shape the frontend's live in-browser transcript
 * produces, so /api/summarize can extract from either source identically.
 *
 * GET /v1/convai/conversations/{conversation_id} response shape verified
 * directly against the live sandbox account (not assumed from docs): each
 * transcript entry has `role: "agent" | "user"` and `message: string | null`
 * (~half the entries on a real call are null-message tool-call/backchannel
 * turns and must be filtered out, not passed to the extractor).
 */
import type { TranscriptTurn } from "./timeline.js";

interface ElevenLabsTranscriptEntry {
  role: string;
  message: string | null;
}

interface ElevenLabsConversationResponse {
  agent_id?: string;
  agent_name?: string;
  status?: string;
  transcript?: ElevenLabsTranscriptEntry[];
  conversation_initiation_client_data?: {
    dynamic_variables?: Record<string, unknown>;
  };
}

export interface FetchedConversation {
  turns: TranscriptTurn[];
  agentName: string | null;
  status: string | null;
  patientFirstName: string | null;
}

export async function fetchConversationTranscript(
  conversationId: string,
  apiKey: string,
): Promise<FetchedConversation> {
  const upstream = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(conversationId)}`, {
    headers: { "xi-api-key": apiKey },
  });
  const body = await upstream.text();
  if (!upstream.ok) {
    throw new Error(`ElevenLabs conversation lookup failed (${upstream.status}): ${body}`);
  }
  const data = JSON.parse(body) as ElevenLabsConversationResponse;

  const turns: TranscriptTurn[] = (data.transcript || [])
    .filter((entry): entry is ElevenLabsTranscriptEntry & { message: string } => Boolean(entry.message))
    .filter((entry) => entry.role === "agent" || entry.role === "user")
    .map((entry) => ({ role: entry.role as "agent" | "user", content: entry.message }));

  const dynamicVariables = data.conversation_initiation_client_data?.dynamic_variables || {};
  const patientFirstName =
    typeof dynamicVariables.patient_first_name === "string" ? dynamicVariables.patient_first_name : null;

  return {
    turns,
    agentName: data.agent_name ?? null,
    status: data.status ?? null,
    patientFirstName,
  };
}
