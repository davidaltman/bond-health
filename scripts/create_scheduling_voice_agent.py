#!/usr/bin/env python3
"""One-off: create the voice-scheduling agent (agent_configs/
05_daphne_scheduling_voice.create.json) in the personal ElevenLabs sandbox
account, then write the resulting agent_id back into that file.

Unlike push_to_sandbox.py (which creates the four-agent 01->04 history-taking
chain and wires transfer_to_agent between them), this creates exactly one
agent with no transfer target -- see that file's own metadata.notes for why:
it delegates its entire scheduling behavior to a client tool the frontend
handles (frontend/src/useVoiceSchedulingConversation.ts), not to another
agent stage.

Usage:
    python3 scripts/create_scheduling_voice_agent.py [--dry-run]

Reads BOND_ELEVEN_LABS_API_KEY (or ELEVENLABS_API_KEY) from server/.env --
same key the running server already uses for get_signed_url, so nothing new
needs to be provisioned to run this.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import requests

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = REPO_ROOT / "agent_configs" / "05_daphne_scheduling_voice.create.json"
ENV_PATH = REPO_ROOT / "server" / ".env"


def read_env_var(path: Path, *names: str) -> str | None:
    if not path.exists():
        return None
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        if key.strip() in names:
            return value.strip().strip('"').strip("'")
    return None


def build_create_payload(config: dict) -> dict:
    # "metadata" is this repo's own bookkeeping, not part of ElevenLabs' schema.
    # "agent_id" is assigned by the server on creation -- the create endpoint's
    # documented body is {name, conversation_config, ...}; it does not accept
    # an agent_id, so this is stripped rather than sent as a harmless extra.
    return {k: v for k, v in config.items() if k not in ("metadata", "agent_id")}


def main() -> int:
    dry_run = "--dry-run" in sys.argv

    api_key = read_env_var(ENV_PATH, "BOND_ELEVEN_LABS_API_KEY", "ELEVENLABS_API_KEY")
    if not api_key:
        print(f"Could not find BOND_ELEVEN_LABS_API_KEY in {ENV_PATH}", file=sys.stderr)
        return 1

    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    payload = build_create_payload(config)

    if dry_run:
        print(f"[dry-run] would POST to /v1/convai/agents/create:")
        print(json.dumps(payload, indent=2))
        return 0

    resp = requests.post(
        "https://api.elevenlabs.io/v1/convai/agents/create",
        headers={"xi-api-key": api_key, "Content-Type": "application/json"},
        json=payload,
        timeout=60,
    )
    if not resp.ok:
        print(f"FAILED creating agent: {resp.status_code} {resp.text}", file=sys.stderr)
        return 1

    agent_id = resp.json()["agent_id"]
    print(f"Created agent -> {agent_id}")

    config["agent_id"] = agent_id
    CONFIG_PATH.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote agent_id back into {CONFIG_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
