#!/usr/bin/env python3
"""One-off: create the four Bond-Daphne agents in a sandbox ElevenLabs account
and wire their transfer_to_agent targets, since these are brand-new agents
(patch_sandbox_agent.py, this repo's other script, only PATCHes agents that
already exist by agent_id).

Creates in reverse order (04 -> 03 -> 02 -> 01) since transfer_to_agent needs
the target agent to already exist, per the bootstrapping note in README.md.

Usage:
    ELEVENLABS_API_KEY=<bond sandbox key> ../../../../../../../.venv/bin/python3 push_to_sandbox.py [--dry-run]

Writes the resulting agent_id map to created_agents.json in this folder.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import requests

CONFIG_DIR = Path(__file__).resolve().parent.parent / "agent_configs"
OUTPUT_PATH = Path(__file__).resolve().parent / "created_agents.json"

# A warm, professional, American-accent female premade voice available on
# every ElevenLabs account (confirmed present on the target sandbox account
# via GET /v2/voices) - stands in for the placeholder "<daphne-voice-id>".
DAPHNE_VOICE_ID = "hpp4J3VqNfWAUOO0d1Us"  # "Bella - Professional, Bright, Warm"

# (stage_key, filename, placeholder-in-prompt-or-transfer-target-that-refers-to-it)
CREATION_ORDER = [
    ("summary", "04_daphne_summary.create.json", None),
    ("family_history", "03_daphne_family_history.create.json", "summary_agent_id"),
    ("personal_history", "02_daphne_personal_history.create.json", "family_history_agent_id"),
    ("intake_consent", "01_daphne_intake_consent.create.json", "personal_history_agent_id"),
]


def substitute_voice_id(obj):
    if isinstance(obj, dict):
        return {k: substitute_voice_id(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [substitute_voice_id(v) for v in obj]
    if obj == "<daphne-voice-id>":
        return DAPHNE_VOICE_ID
    return obj


def substitute_transfer_target(obj, placeholder: str, real_id: str):
    """Replace `{{placeholder}}` wherever it appears as a transfer agent_id."""
    if isinstance(obj, dict):
        return {k: substitute_transfer_target(v, placeholder, real_id) for k, v in obj.items()}
    if isinstance(obj, list):
        return [substitute_transfer_target(v, placeholder, real_id) for v in obj]
    if obj == f"{{{{{placeholder}}}}}":
        return real_id
    return obj


def build_create_payload(config: dict, resolved_transfer: tuple[str, str] | None) -> dict:
    payload = {k: v for k, v in config.items() if k != "metadata"}
    payload = substitute_voice_id(payload)
    if resolved_transfer:
        placeholder, real_id = resolved_transfer
        payload = substitute_transfer_target(payload, placeholder, real_id)
    return payload


def parse_reuse_map() -> dict[str, str]:
    """--reuse stage_key=agent_id (repeatable): skip creating stages we already made."""
    reuse = {}
    for arg in sys.argv:
        if arg.startswith("--reuse="):
            stage_key, agent_id = arg[len("--reuse="):].split("=", 1)
            reuse[stage_key] = agent_id
    return reuse


def main() -> int:
    dry_run = "--dry-run" in sys.argv
    reuse = parse_reuse_map()
    api_key = os.getenv("ELEVENLABS_API_KEY")
    if not api_key:
        print("ELEVENLABS_API_KEY not set in environment", file=sys.stderr)
        return 1

    created: dict[str, str] = {}
    downstream_id_by_placeholder: dict[str, str] = {}

    for stage_key, filename, placeholder_this_stage_fills in CREATION_ORDER:
        if stage_key in reuse:
            created[stage_key] = reuse[stage_key]
            print(f"Reusing existing {filename} -> {stage_key} = {reuse[stage_key]}")
            next_placeholder = {
                "summary": "summary_agent_id",
                "family_history": "family_history_agent_id",
                "personal_history": "personal_history_agent_id",
            }.get(stage_key)
            if next_placeholder:
                downstream_id_by_placeholder[next_placeholder] = created[stage_key]
            continue

        config = json.loads((CONFIG_DIR / filename).read_text(encoding="utf-8"))

        resolved_transfer = None
        if placeholder_this_stage_fills:
            # The placeholder name equals "<next-stage>_agent_id" and refers to
            # the agent created in the PREVIOUS loop iteration.
            resolved_transfer = (placeholder_this_stage_fills, downstream_id_by_placeholder[placeholder_this_stage_fills])

        payload = build_create_payload(config, resolved_transfer)

        if dry_run:
            print(f"[dry-run] would create {filename} -> name={payload['name']}")
            if resolved_transfer:
                print(f"           transfer target {resolved_transfer[0]} = {resolved_transfer[1]}")
            created[stage_key] = f"DRY-RUN-{stage_key}"
        else:
            resp = requests.post(
                "https://api.elevenlabs.io/v1/convai/agents/create",
                headers={"xi-api-key": api_key, "Content-Type": "application/json"},
                json=payload,
                timeout=60,
            )
            if not resp.ok:
                print(f"FAILED creating {filename}: {resp.status_code} {resp.text}", file=sys.stderr)
                print(f"Created so far: {json.dumps(created, indent=2)}", file=sys.stderr)
                return 1
            agent_id = resp.json()["agent_id"]
            created[stage_key] = agent_id
            print(f"Created {filename} -> {stage_key} = {agent_id}")

        # This stage's own agent_id is the value the NEXT (earlier-in-flow) stage's
        # placeholder needs.
        next_placeholder = {
            "summary": "summary_agent_id",
            "family_history": "family_history_agent_id",
            "personal_history": "personal_history_agent_id",
        }.get(stage_key)
        if next_placeholder:
            downstream_id_by_placeholder[next_placeholder] = created[stage_key]

    OUTPUT_PATH.write_text(json.dumps(created, indent=2) + "\n", encoding="utf-8")
    print(f"\nWrote {OUTPUT_PATH}")
    print(json.dumps(created, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
