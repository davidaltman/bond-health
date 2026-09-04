#!/usr/bin/env python3
"""One-off: create the 4 new per-relative family-history agents (mother ->
father -> siblings -> grandparents) that REPLACE the single monolithic
03_daphne_family_history agent, and wire their transfer_to_agent chain.

These are brand-new agents, so this uses POST /v1/convai/agents/create (like
push_to_sandbox.py), not a PATCH. Creates in reverse order (grandparents ->
siblings -> father -> mother) since transfer_to_agent needs the target
agent to already exist. Grandparents' target (Summary) and each stage's
early-exit target (also Summary) are already-known, hardcoded agent_ids in
the config files -- only the "next relative" link needs runtime
substitution here.

After this script succeeds, 02_daphne_personal_history.create.json's
transfer_to_agent target must be separately repointed at the new Mother
agent_id and PATCHed live (see patch_sandbox_agent.py) -- not done by this
script, since 02 already exists and is PATCHed, not created.

Usage:
    BOND_ELEVEN_LABS_API_KEY=<key> ../../../../../../../.venv/bin/python3 \\
        create_family_relative_agents.py [--dry-run]

Writes the resulting agent_id map to family_relative_agents.json in this
folder, and prints the map for manual insertion into the *.create.json
files' top-level "agent_id" field.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import requests

CONFIG_DIR = Path(__file__).resolve().parent.parent / "agent_configs"
OUTPUT_PATH = Path(__file__).resolve().parent / "family_relative_agents.json"

# (stage_key, filename) in creation order (reverse of conversational order,
# since transfer_to_agent needs the target agent_id to already exist).
CREATION_ORDER = [
    ("grandparents", "03d_daphne_family_grandparents.create.json"),
    ("siblings", "03c_daphne_family_siblings.create.json"),
    ("father", "03b_daphne_family_father.create.json"),
    ("mother", "03a_daphne_family_mother.create.json"),
]


def substitute_next_relative(obj, real_id: str):
    if isinstance(obj, dict):
        return {k: substitute_next_relative(v, real_id) for k, v in obj.items()}
    if isinstance(obj, list):
        return [substitute_next_relative(v, real_id) for v in obj]
    if obj == "{{next_relative_agent_id}}":
        return real_id
    return obj


def build_create_payload(config: dict, next_relative_id: str | None) -> dict:
    payload = {k: v for k, v in config.items() if k not in ("metadata", "agent_id")}
    if next_relative_id:
        payload = substitute_next_relative(payload, next_relative_id)
    return payload


def main() -> int:
    dry_run = "--dry-run" in sys.argv
    api_key = os.getenv("BOND_ELEVEN_LABS_API_KEY") or os.getenv("ELEVENLABS_API_KEY")
    if not api_key:
        print("BOND_ELEVEN_LABS_API_KEY (or ELEVENLABS_API_KEY) not set in environment", file=sys.stderr)
        return 1

    created: dict[str, str] = {}
    next_relative_id: str | None = None  # id of the stage created in the PREVIOUS loop iteration

    for stage_key, filename in CREATION_ORDER:
        config = json.loads((CONFIG_DIR / filename).read_text(encoding="utf-8"))
        payload = build_create_payload(config, next_relative_id)

        remaining_placeholder = "{{next_relative_agent_id}}" in json.dumps(payload)
        if remaining_placeholder:
            print(f"FAILED: {filename} still has an unresolved {{{{next_relative_agent_id}}}} placeholder", file=sys.stderr)
            return 1

        if dry_run:
            print(f"[dry-run] would create {filename} -> name={payload['name']}")
            if next_relative_id:
                print(f"           next-relative target = {next_relative_id}")
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

        # This stage's own id is what the PREVIOUS (earlier-in-conversation) stage's
        # {{next_relative_agent_id}} placeholder needs.
        next_relative_id = created[stage_key]

    OUTPUT_PATH.write_text(json.dumps(created, indent=2) + "\n", encoding="utf-8")
    print(f"\nWrote {OUTPUT_PATH}")
    print(json.dumps(created, indent=2))
    print("\nNext steps (not done by this script):")
    print("  1. Insert each agent_id into the matching *.create.json file's top-level \"agent_id\" field.")
    print("  2. Repoint 02_daphne_personal_history.create.json's transfer_to_agent target at the new mother id.")
    print("  3. PATCH the live 02 agent via patch_sandbox_agent.py.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
