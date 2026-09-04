#!/usr/bin/env python3
"""PATCH an existing Bond-Daphne agent on the sandbox ElevenLabs account from
its local *.create.json config (used after the initial push_to_sandbox.py
creation, for follow-up fixes to an already-live agent_id).

`PATCH /v1/convai/agents/{id}` replaces conversation_config wholesale, so this
always fetches live first and prints a small before/after diff on the fields
that matter (tool_ids, transfer targets, prompt length) before writing.

Usage:
    BOND_ELEVEN_LABS_API_KEY=<key> ../../../../../../../.venv/bin/python3 \
        patch_sandbox_agent.py <config_filename> [--dry-run] [--yes]

    e.g. patch_sandbox_agent.py 02_daphne_personal_history.create.json --yes
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import requests

CONFIG_DIR = Path(__file__).resolve().parent.parent / "agent_configs"


def summarize(conversation_config: dict) -> dict:
    prompt = conversation_config.get("agent", {}).get("prompt", {})
    transfers = (
        prompt.get("built_in_tools", {}).get("transfer_to_agent", {}) or {}
    ).get("params", {}).get("transfers", [])
    return {
        "tool_ids": prompt.get("tool_ids", []),
        "tools_count": len(prompt.get("tools", []) or []),
        "prompt_chars": len(prompt.get("prompt", "") or ""),
        "transfer_targets": [t.get("agent_id") for t in transfers],
    }


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry_run = "--dry-run" in sys.argv
    skip_confirm = "--yes" in sys.argv
    if not args:
        print("usage: patch_sandbox_agent.py <config_filename> [--dry-run] [--yes]", file=sys.stderr)
        return 1
    config_path = CONFIG_DIR / args[0]
    if not config_path.is_file():
        print(f"Config file not found: {config_path}", file=sys.stderr)
        return 1

    api_key = os.getenv("BOND_ELEVEN_LABS_API_KEY") or os.getenv("ELEVENLABS_API_KEY")
    if not api_key:
        print("BOND_ELEVEN_LABS_API_KEY (or ELEVENLABS_API_KEY) not set in environment", file=sys.stderr)
        return 1

    config = json.loads(config_path.read_text(encoding="utf-8"))
    agent_id = config.get("agent_id")
    if not agent_id:
        print(f"No agent_id in {config_path}", file=sys.stderr)
        return 1

    payload = {
        "name": config["name"],
        "conversation_config": config["conversation_config"],
    }

    live_resp = requests.get(
        f"https://api.elevenlabs.io/v1/convai/agents/{agent_id}",
        headers={"xi-api-key": api_key},
        timeout=30,
    )
    if not live_resp.ok:
        print(f"Failed to fetch live agent {agent_id}: {live_resp.status_code} {live_resp.text}", file=sys.stderr)
        return 1
    live = live_resp.json()

    before = summarize(live.get("conversation_config", {}))
    after = summarize(payload["conversation_config"])

    print(f"\n{'=' * 78}\nPATCH DIFF for {config_path.name} -> {agent_id}\n{'=' * 78}")
    for key in before:
        marker = "  " if before[key] == after[key] else "->"
        print(f"  {key:18s} live={before[key]!r} {marker} new={after[key]!r}")

    if dry_run:
        print("\n--dry-run: nothing was written.")
        return 0

    if not skip_confirm:
        answer = input(f'\nType the agent id ("{agent_id}") to confirm the PATCH, anything else to abort: ')
        if answer.strip() != agent_id:
            print("Aborted. Nothing was pushed.", file=sys.stderr)
            return 1

    resp = requests.patch(
        f"https://api.elevenlabs.io/v1/convai/agents/{agent_id}",
        headers={"xi-api-key": api_key, "Content-Type": "application/json"},
        json=payload,
        timeout=60,
    )
    if not resp.ok:
        print(f"PATCH failed: {resp.status_code} {resp.text}", file=sys.stderr)
        return 1
    print(f"\nPatched {agent_id} from {config_path.name}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
