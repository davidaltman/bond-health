/**
 * Minimal local backend for the Bond Health / Daphne demo frontend.
 *
 * Two jobs, both deliberately server-side only:
 *  1. Proxy ElevenLabs' get_signed_url so BOND_ELEVEN_LABS_API_KEY never
 *     reaches the browser (the frontend is a thin wrapper -- it must not
 *     expose ElevenLabs credentials or even that ElevenLabs is the backing
 *     provider).
 *  2. Run the post-call timeline extraction (see timeline.ts) once a
 *     conversation has ended, so the frontend can render a summary + Mermaid
 *     diagram without needing model credentials itself.
 *
 * Not a production service: no auth, no rate limiting, CORS wide open to the
 * local Vite dev origin only. Sandbox demo, matching the rest of
 * docs/reference/bond_health_demo/.
 */
import cors from "cors";
import express from "express";
import { extractHealthEvents, buildAgeTimeline, type TranscriptTurn } from "./timeline.js";
import { generateFollowUps } from "./followups.js";
import { BOND_AGENTS, DEFAULT_AGENT_ID, SCHEDULING_VOICE_AGENT_ID } from "./agents.js";
import { fetchConversationTranscript } from "./conversations.js";
import { appendTurn, createSession, exchange, exportScenario, getSession, settle } from "./sessions.js";
import { liveFacts } from "./ledger.js";

const PORT = Number(process.env.PORT || 8790);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://127.0.0.1:5190";

function getElevenLabsApiKey(): string | null {
  return process.env.BOND_ELEVEN_LABS_API_KEY || process.env.ELEVENLABS_API_KEY || null;
}

const app = express();
app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/agents", (_req, res) => {
  res.json({ agents: BOND_AGENTS, defaultAgentId: DEFAULT_AGENT_ID, schedulingVoiceAgentId: SCHEDULING_VOICE_AGENT_ID });
});

app.get("/api/signed-url", async (req, res) => {
  const agentId = String(req.query.agentId || "");
  if (!agentId) {
    res.status(400).json({ error: "agentId query param is required" });
    return;
  }
  const apiKey = getElevenLabsApiKey();
  if (!apiKey) {
    res.status(500).json({ error: "BOND_ELEVEN_LABS_API_KEY is not set on the server" });
    return;
  }
  try {
    const url = new URL("https://api.elevenlabs.io/v1/convai/conversation/get_signed_url");
    url.searchParams.set("agent_id", agentId);
    const upstream = await fetch(url, { headers: { "xi-api-key": apiKey } });
    const body = await upstream.text();
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `ElevenLabs get_signed_url failed: ${body}` });
      return;
    }
    const parsed = JSON.parse(body) as { signed_url?: string };
    if (!parsed.signed_url) {
      res.status(502).json({ error: "ElevenLabs response missing signed_url" });
      return;
    }
    res.json({ signedUrl: parsed.signed_url });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/summarize", async (req, res) => {
  const conversationId = String(req.body?.conversationId || "").trim();
  let patientName = String(req.body?.patientName || "the patient");
  const rawAge = req.body?.patientAge;
  const patientAge = typeof rawAge === "number" && Number.isFinite(rawAge) && rawAge > 0 ? rawAge : null;
  let turns: TranscriptTurn[] | undefined;
  let sourceInfo: { conversationId: string; agentName: string | null; status: string | null } | null = null;

  try {
    if (conversationId) {
      const apiKey = getElevenLabsApiKey();
      if (!apiKey) {
        res.status(500).json({ error: "BOND_ELEVEN_LABS_API_KEY is not set on the server" });
        return;
      }
      const fetched = await fetchConversationTranscript(conversationId, apiKey);
      if (fetched.turns.length === 0) {
        res.status(422).json({ error: `Conversation ${conversationId} has no usable transcript turns yet.` });
        return;
      }
      turns = fetched.turns;
      if (fetched.patientFirstName) patientName = fetched.patientFirstName;
      sourceInfo = { conversationId, agentName: fetched.agentName, status: fetched.status };
    } else {
      turns = req.body?.transcript as TranscriptTurn[] | undefined;
    }

    if (!Array.isArray(turns) || turns.length === 0) {
      res.status(400).json({ error: "Either a non-empty transcript or a valid conversationId is required" });
      return;
    }

    const extraction = await extractHealthEvents(turns);
    const timelineChart = buildAgeTimeline(
      extraction.health_events,
      `Health Timeline -- ${patientName} (extracted from completed call)`,
    );
    // Insights & actions is a separate, best-effort pass -- a failure here
    // must not take down the summary/timeline the rest of the panel needs.
    const followUps = await generateFollowUps(extraction.health_events, patientAge).catch((error) => {
      // eslint-disable-next-line no-console
      console.error("generateFollowUps failed unexpectedly:", error);
      return [];
    });
    res.json({
      sessionSummary: extraction.session_summary,
      healthEvents: extraction.health_events,
      timelineChart,
      followUps,
      patientName,
      source: sourceInfo,
      transcript: turns.map((turn) => ({ role: turn.role, content: turn.content })),
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// ---------------------------------------------------------------------------
// Live session memory (Phase 1). Unlike /api/summarize above, which re-reads a
// finished transcript, these endpoints maintain a queryable ledger while the
// call is still running -- see docs/phase-1-spec.md.
// ---------------------------------------------------------------------------

app.post("/api/session", (req, res) => {
  const mode = req.body?.mode === "scheduling_only" ? "scheduling_only" : "full";
  const session = createSession(req.body?.patientName, req.body?.patientAge, mode);
  res.json({ sessionId: session.id, createdAt: session.createdAt, mode: session.mode });
});

app.post("/api/session/:id/turn", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: `No session ${req.params.id}` });
    return;
  }
  const role = req.body?.role === "agent" ? "agent" : "user";
  const content = String(req.body?.content ?? "");
  try {
    const result = await appendTurn(session, role, content);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// The text path: one call in, Daphne's decision-driven reply out. This is the
// primary medium (see README "text-first, voice adapter behind it") because it
// is the only one where the agent's next sentence is genuinely a consequence of
// the gates rather than a parallel commentary on them.
app.post("/api/session/:id/message", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: `No session ${req.params.id}` });
    return;
  }
  const content = String(req.body?.content ?? "").trim();
  if (!content) {
    res.status(400).json({ error: "content is required" });
    return;
  }
  try {
    res.json(await exchange(session, content));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Review: a human marks a turn that went wrong, and that turn becomes a
// regression case. This is the loop between the two halves of "watching and
// improving" -- without it, live review produces opinions and the eval suite
// stays frozen at whatever its author imagined.
app.post("/api/session/:id/flag", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: `No session ${req.params.id}` });
    return;
  }
  const flag = {
    turn: Number(req.body?.turn),
    note: String(req.body?.note ?? "").trim() || "flagged without a note",
    expectedOutcome: req.body?.expectedOutcome ? String(req.body.expectedOutcome) : null,
    at: new Date().toISOString(),
  };
  if (!Number.isInteger(flag.turn)) {
    res.status(400).json({ error: "turn must be an integer" });
    return;
  }
  session.flags.push(flag);
  res.json({ flags: session.flags });
});

app.get("/api/session/:id/scenario", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: `No session ${req.params.id}` });
    return;
  }
  await settle(session);
  const name = String(req.query.name ?? `captured_${session.id.slice(0, 8)}`);
  res.json(exportScenario(session, name));
});

app.get("/api/session/:id", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: `No session ${req.params.id}` });
    return;
  }
  // Don't hand back a view that's mid-write on the last thing the patient said.
  await settle(session);
  res.json({
    sessionId: session.id,
    patientName: session.patientName,
    patientAge: session.patientAge,
    mode: session.mode,
    turns: session.turns,
    facts: liveFacts(session.ledger),
    allFacts: session.ledger.facts,
    signals: session.signals,
    decisions: session.decisions,
    decision: session.decisions.at(-1) ?? null,
    resolution: session.resolution,
    flags: session.flags,
    trace: session.trace,
  });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Bond Health demo server listening on http://127.0.0.1:${PORT}`);
});
