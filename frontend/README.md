# Bond Health Demo — Local Frontend

A local-only, white-labeled ("AltmanAI") web UI for running the Bond-Daphne
voice health-intake demo end to end: start/stop a live call with the
sandbox ElevenLabs agents, watch the transcript scroll in as it happens, and
generate a post-call summary + Mermaid health timeline.

This is a throwaway demo tool, not a product. It never talks to ElevenLabs
directly with a browser-exposed API key — see `../server/` for why.

```
docs/reference/bond_health_demo/
├── frontend/   <- this app (Vite + React + TypeScript)
└── server/     <- companion Node/TypeScript backend (run this first)
```

## Architecture

- **Frontend** (`frontend/`): Vite + React 19 + TypeScript. Uses
  `@elevenlabs/client`'s `Conversation.startSession({ signedUrl, ... })`
  directly in the browser for the live mic call (websocket transport), and
  renders the streaming transcript via `onMessage`. Timeline diagrams render
  with `mermaid` (lazy-loaded).
- **Server** (`server/`): minimal Express + TypeScript backend with two jobs:
  1. `GET /api/signed-url?agentId=...` — proxies ElevenLabs'
     `get_signed_url` using `BOND_ELEVEN_LABS_API_KEY` server-side, so the
     key never reaches the browser and the frontend never needs to know it's
     talking to ElevenLabs.
  2. `POST /api/summarize` — runs the same post-call Bedrock extraction as
     `../scripts/extract_and_render_timeline.py` (kept in sync by hand; see
     `server/src/timeline.ts`), returning a session summary, structured
     health events, and a rendered Mermaid timeline string. Accepts either
     `{ transcript: [...] }` (the live in-browser transcript) or
     `{ conversationId: "conv_..." }`, in which case the server fetches the
     transcript from ElevenLabs' `GET /v1/convai/conversations/{id}` first
     (see `server/src/conversations.ts`) — this is how "generate from a past
     conversation id" works without the browser ever touching ElevenLabs.

The 4 Bond-Daphne sandbox agents (Intake & Consent → Personal History →
Family History → Summary) hand off to each other automatically via
ElevenLabs `transfer_to_agent` once a call starts — the frontend only needs
to connect to one agent at a time (defaults to Intake & Consent). Agent ids
live in `server/src/agents.ts` and mirror `../scripts/created_agents.json`.

## Prerequisites

- Node.js 20+ (repo default is newer; anything reasonably current works)
- The Bond sandbox ElevenLabs API key (copy `server/.env.example` to
  `server/.env` and set `BOND_ELEVEN_LABS_API_KEY`)
- AWS credentials with Bedrock access in `us-west-2` (same SSO profile used
  by `extract_and_render_timeline.py`) for the summary/timeline endpoint —
  not required just to run a call and watch the transcript.
- A working microphone + browser mic permission (this is a voice demo, not
  text chat).

## Run it

**Terminal 1 — backend (port 8790):**

```bash
cd apps/voice-agent-collections-backend/docs/reference/bond_health_demo/server
npm install   # first time only
BOND_ELEVEN_LABS_API_KEY=<sandbox key> \
AWS_PROFILE=<your bedrock-capable sso profile> \
AWS_REGION=us-west-2 \
npm run dev
```

**Terminal 2 — frontend (port 5190):**

```bash
cd apps/voice-agent-collections-backend/docs/reference/bond_health_demo/frontend
npm install   # first time only
npm run dev
```

Open **http://127.0.0.1:5190**.

If you want the frontend to point at a server on a different host/port, copy
`.env.example` to `.env.local` and set `VITE_SERVER_URL`.

## Using it

1. Enter a patient first name (used as `patient_first_name` dynamic
   variable — matches what the Daphne prompts expect) and pick which agent
   to start on (defaults to Intake & Consent for a full run-through).
2. Click **Start call**, allow microphone access, and talk to Daphne. The
   transcript panel scrolls live as `agent`/`user` turns arrive.
3. Click **Stop call** to end the session at any point.
4. Click **Generate from call** in the right-hand panel to POST the full
   transcript to the backend, which runs the Bedrock extraction and renders
   a Mermaid timeline (swimlanes per person: Self / Mother / Father /
   Sibling / etc.) plus a short text summary and the structured health
   events list.
5. Alternatively, paste an ElevenLabs conversation id (e.g.
   `conv_7001m0649qxqftvbtzvxnns81nk0`) into the **"Or pull a past
   conversation by id"** field. The button label switches to **Generate
   from conversation**; clicking it fetches that conversation's transcript
   directly from ElevenLabs (server-side) instead of using the live call
   above, and also auto-fills the patient name from the call's
   `patient_first_name` dynamic variable if present. Leave the field blank
   to fall back to the live transcript.

## Known limitations

- No auto-reconnect if the WebSocket drops mid-call — click Stop then Start
  again.
- `log_health_fact` (live mid-call logging) is stubbed on all 4 agents (see
  `../README.md` "Fixes applied 2026-08-16"), so `Generate from call` is
  currently the *only* source of structured health events — it's a
  deliberate post-call-only design, not a bug.
- No persistence: refreshing the page loses the current transcript/summary.
