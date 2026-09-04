#!/usr/bin/env python3
"""Post-call timeline extraction + Mermaid render for the Bond Health demo.

Implements the "authoritative pass" described in
../extraction/timeline_extraction_prompt.md: reads a FINISHED conversation
transcript (never a live/rolling one -- log_health_fact is stubbed, so this
script is currently the only source of `health_events` for the demo), asks a
Bedrock model to extract structured health_events per the documented schema,
then renders them as a `timeline` Mermaid diagram with one swimlane per person
(self / mother / father / sibling / ...), matching the style of
../diagrams/example_health_timeline.mmd.

Input can be either:
  - a replay harness artifact (*.replay.json from
    run_elevenlabs_conversation_replay_multitenant.mjs), via --replay-json, or
  - a plain JSON list of {"role": "agent"|"user"|"customer", "content": str}
    turns, via --transcript-json

Usage:
    AWS_PROFILE=<sso-profile> ../../../../../../../.venv/bin/python3 \\
        extract_and_render_timeline.py \\
        --replay-json <path/to/conv_xxx.replay.json> \\
        --patient-name Jordan \\
        --out-dir <output dir>

Requires ambient AWS credentials (SSO) with bedrock:Converse -- same
requirement as the replay harness's --llm-provider bedrock path.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import boto3

DEFAULT_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
DEFAULT_REGION = "us-west-2"

EXTRACTION_SYSTEM_PROMPT = """You are a clinical history extraction system. You will be given a transcript of a
conversation between a patient and Daphne, a voice health assistant, along with a
list of facts that were already logged in real time during the call.

Your job is to produce a complete, deduplicated, reconciled list of structured
health events mentioned anywhere in the transcript -- personal and family history.

RULES:
1. Extract only what the patient actually stated. Never infer a diagnosis, never
   add clinical interpretation, never assume something not said.
2. If a fact appears in both the transcript and the already-logged list, merge
   them into one entry rather than duplicating -- prefer the more complete/specific
   description, but flag a conflict if the two sources disagree on a material
   detail (e.g. logged says "age 30", transcript context implies "age 40").
3. Assign `person` as "self" for the patient's own history, or the specific
   relation ("mother", "father", "sibling", etc.) for family history. Never guess
   a relation that wasn't stated.
4. Assign a `confidence` of "high" only when the patient stated the fact clearly
   and specifically (named condition, clear approximate age/date). Use "medium"
   or "low" for vague, hedged, or incomplete statements.
5. Do not fabricate an `approx_age` if none was given or inferable from context
   (e.g. "when I was in college" is inferable if age is known; a bare "a while
   ago" is not -- leave it null).
6. Output ONLY the JSON object below. No prose, no explanation."""

HEALTH_EVENTS_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "health_events": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "person": {"type": "string"},
                    "category": {
                        "type": "string",
                        "enum": ["surgery", "medication", "condition", "symptom", "family_history"],
                    },
                    "subcategory": {"type": ["string", "null"]},
                    "description": {"type": "string"},
                    "approx_age": {"type": ["integer", "null"]},
                    "still_living": {"type": ["boolean", "null"]},
                    "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                    "source_quote": {"type": "string"},
                    "conflict_with_logged_fact": {"type": "boolean"},
                    "conflict_note": {"type": ["string", "null"]},
                },
                "required": [
                    "person",
                    "category",
                    "subcategory",
                    "description",
                    "approx_age",
                    "still_living",
                    "confidence",
                    "source_quote",
                    "conflict_with_logged_fact",
                    "conflict_note",
                ],
            },
        },
        "session_summary": {"type": "string"},
    },
    "required": ["health_events", "session_summary"],
}


def load_transcript_from_replay_json(path: Path) -> list[dict[str, str]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    turns = data.get("live_transcript") or data.get("source_transcript") or []
    normalized = []
    for turn in turns:
        role = str(turn.get("role", "")).strip()
        content = str(turn.get("content", "")).strip()
        if not content:
            continue
        normalized.append({"role": "patient" if role in ("user", "customer") else "agent", "content": content})
    return normalized


def load_transcript_from_json(path: Path) -> list[dict[str, str]]:
    turns = json.loads(path.read_text(encoding="utf-8"))
    normalized = []
    for turn in turns:
        role = str(turn.get("role", "")).strip()
        content = str(turn.get("content", "")).strip()
        if not content:
            continue
        normalized.append({"role": "patient" if role in ("user", "customer") else "agent", "content": content})
    return normalized


def transcript_to_text(turns: list[dict[str, str]]) -> str:
    lines = []
    for index, turn in enumerate(turns, start=1):
        speaker = "daphne" if turn["role"] == "agent" else "patient"
        lines.append(f"{index}. {speaker}: {turn['content']}")
    return "\n".join(lines)


def call_bedrock_extraction(
    *,
    transcript_text: str,
    already_logged_facts: list[dict[str, Any]],
    model_id: str,
    region: str,
) -> dict[str, Any]:
    client = boto3.client("bedrock-runtime", region_name=region)
    user_prompt = (
        "Transcript:\n"
        f"{transcript_text}\n\n"
        "Facts already logged via log_health_fact tool calls during the call "
        "(empty in this demo -- the tool is currently stubbed, see "
        "../README.md \"Fixes applied 2026-08-16\"):\n"
        f"{json.dumps(already_logged_facts, indent=2)}\n\n"
        "Return strict JSON matching the schema you were given."
    )
    response = client.converse(
        modelId=model_id,
        system=[{"text": EXTRACTION_SYSTEM_PROMPT}],
        messages=[{"role": "user", "content": [{"text": user_prompt}]}],
        inferenceConfig={"maxTokens": 4096},
        outputConfig={
            "textFormat": {
                "type": "json_schema",
                "structure": {
                    "jsonSchema": {
                        "schema": json.dumps(HEALTH_EVENTS_JSON_SCHEMA),
                        "name": "health_events_extraction",
                    }
                },
            }
        },
    )
    message = response.get("output", {}).get("message", {})
    text_parts = [b["text"] for b in message.get("content", []) if isinstance(b, dict) and b.get("text")]
    text = "".join(text_parts).strip()
    if not text:
        raise RuntimeError("Bedrock extraction returned empty output")
    return json.loads(text)


PERSON_SECTION_ORDER = ["self", "mother", "father", "sibling", "grandmother", "grandfather"]


def _section_label(person: str) -> str:
    normalized = person.strip().lower()
    if normalized == "self":
        return "Self"
    return normalized.replace("_", " ").title()


def _sort_key(person: str) -> tuple[int, str]:
    normalized = person.strip().lower()
    try:
        return (PERSON_SECTION_ORDER.index(normalized), normalized)
    except ValueError:
        return (len(PERSON_SECTION_ORDER), normalized)


def render_mermaid_timeline(health_events: list[dict[str, Any]], title: str) -> str:
    """Debug/reference-only mermaid rendering (kept for quick CLI inspection).

    The canonical, product-facing timeline visualization is now
    `server/src/timeline.ts`'s `buildAgeTimeline` + the frontend's
    `TimelineChart.tsx` -- a real shared-age-axis swimlane chart, since
    mermaid's `timeline` diagram type has no numeric axis and can only list
    items sequentially per section. This function still emits that mermaid
    text for a quick eyeball check from the CLI, but applies the same
    plotting rule as the TS version: an event only appears if it has a known
    `approx_age` (there's no x-position to place it at otherwise) -- this
    mostly excludes medications without a start age and conditions mentioned
    without an onset age (e.g. "she also had asthma" with no age given).
    Those events are still present in `health_events.json` and the prose
    summary, just not on the timeline.
    """
    plottable = [event for event in health_events if event.get("approx_age") is not None]

    by_person: dict[str, list[dict[str, Any]]] = {}
    for event in plottable:
        person = str(event.get("person") or "self").strip().lower()
        by_person.setdefault(person, []).append(event)

    lines = ["timeline", f"    title {title}", ""]
    for person in sorted(by_person, key=_sort_key):
        events = by_person[person]
        events.sort(key=lambda e: e.get("approx_age") or 0)
        lines.append(f"    section {_section_label(person)}")
        for event in events:
            age = event.get("approx_age")
            age_label = f"Age {age}"
            category = event.get("category") or ""
            subcategory = event.get("subcategory")
            desc = event.get("description") or ""
            still_living = event.get("still_living")
            tag = f"{category}:{subcategory}" if subcategory else category
            suffix = f" ({tag})" if tag else ""
            if person != "self" and still_living is not None:
                suffix += " -- living" if still_living else " -- deceased"
            lines.append(f"        {age_label}   : {desc}{suffix}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--replay-json", type=Path, help="Path to a *.replay.json harness artifact")
    parser.add_argument("--transcript-json", type=Path, help="Path to a plain JSON transcript array")
    parser.add_argument("--patient-name", default="the patient")
    parser.add_argument("--model-id", default=DEFAULT_MODEL_ID)
    parser.add_argument("--region", default=DEFAULT_REGION)
    parser.add_argument("--out-dir", type=Path, required=True)
    args = parser.parse_args()

    if not args.replay_json and not args.transcript_json:
        print("Provide --replay-json or --transcript-json", file=sys.stderr)
        return 1

    turns = (
        load_transcript_from_replay_json(args.replay_json)
        if args.replay_json
        else load_transcript_from_json(args.transcript_json)
    )
    if not turns:
        print("No transcript turns found in input.", file=sys.stderr)
        return 1

    transcript_text = transcript_to_text(turns)
    print(f"Loaded {len(turns)} transcript turns. Calling Bedrock ({args.model_id})...", file=sys.stderr)

    extraction = call_bedrock_extraction(
        transcript_text=transcript_text,
        already_logged_facts=[],
        model_id=args.model_id,
        region=args.region,
    )
    health_events = extraction.get("health_events", [])
    session_summary = extraction.get("session_summary", "")

    args.out_dir.mkdir(parents=True, exist_ok=True)
    events_path = args.out_dir / "health_events.json"
    events_path.write_text(json.dumps(extraction, indent=2), encoding="utf-8")

    title = f"Health Timeline -- {args.patient_name} (extracted from completed call)"
    mermaid = render_mermaid_timeline(health_events, title)
    mmd_path = args.out_dir / "health_timeline.mmd"
    mmd_path.write_text(mermaid, encoding="utf-8")

    print(f"\n{len(health_events)} health_events extracted.", file=sys.stderr)
    print(f"Session summary: {session_summary}\n", file=sys.stderr)
    print(f"Wrote: {events_path}", file=sys.stderr)
    print(f"Wrote: {mmd_path}", file=sys.stderr)
    print("\n--- Mermaid diagram ---\n", file=sys.stderr)
    print(mermaid)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
