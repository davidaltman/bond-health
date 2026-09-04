/**
 * Post-call health-events extraction + age-axis timeline chart data.
 *
 * TypeScript port of ../scripts/extract_and_render_timeline.py, kept in sync
 * by hand (schema, prompt, and rendering logic must match). See
 * ../extraction/timeline_extraction_prompt.md for the design this
 * implements. Deliberately post-call only: log_health_fact (the live
 * mid-call logging tool) is stubbed, so this is currently the only source of
 * health_events for the demo.
 */
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

export interface TranscriptTurn {
  role: "agent" | "user" | "customer" | "patient";
  content: string;
}

export interface HealthEvent {
  person: string;
  category: "surgery" | "medication" | "condition" | "symptom" | "family_history";
  subcategory: string | null;
  description: string;
  approx_age: number | null;
  still_living: boolean | null;
  confidence: "high" | "medium" | "low";
  source_quote: string;
  conflict_with_logged_fact: boolean;
  conflict_note: string | null;
}

export interface ExtractionResult {
  health_events: HealthEvent[];
  session_summary: string;
}

const DEFAULT_MODEL_ID = process.env.BEDROCK_MODEL_ID || "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const DEFAULT_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-west-2";

const EXTRACTION_SYSTEM_PROMPT = `You are a clinical history extraction system. You will be given a transcript of a
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
3. Assign \`person\` as "self" for the patient's own history, or the specific
   relation ("mother", "father", "sibling", etc.) for family history. Never guess
   a relation that wasn't stated.
4. Assign a \`confidence\` of "high" only when the patient stated the fact clearly
   and specifically (named condition, clear approximate age/date). Use "medium"
   or "low" for vague, hedged, or incomplete statements.
5. Do not fabricate an \`approx_age\` if none was given or inferable from context
   (e.g. "when I was in college" is inferable if age is known; a bare "a while
   ago" is not -- leave it null).
6. Output ONLY the JSON object below. No prose, no explanation.`;

const HEALTH_EVENTS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    health_events: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          person: { type: "string" },
          category: {
            type: "string",
            enum: ["surgery", "medication", "condition", "symptom", "family_history"],
          },
          subcategory: { type: ["string", "null"] },
          description: { type: "string" },
          approx_age: { type: ["integer", "null"] },
          still_living: { type: ["boolean", "null"] },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          source_quote: { type: "string" },
          conflict_with_logged_fact: { type: "boolean" },
          conflict_note: { type: ["string", "null"] },
        },
        required: [
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
    session_summary: { type: "string" },
  },
  required: ["health_events", "session_summary"],
};

function transcriptToText(turns: TranscriptTurn[]): string {
  return turns
    .map((turn, index) => {
      const speaker = turn.role === "agent" ? "daphne" : "patient";
      return `${index + 1}. ${speaker}: ${turn.content}`;
    })
    .join("\n");
}

export async function extractHealthEvents(turns: TranscriptTurn[]): Promise<ExtractionResult> {
  const client = new BedrockRuntimeClient({ region: DEFAULT_REGION });
  const userPrompt = [
    "Transcript:",
    transcriptToText(turns),
    "",
    "Facts already logged via log_health_fact tool calls during the call",
    "(empty in this demo -- the tool is currently stubbed):",
    "[]",
    "",
    "Return strict JSON matching the schema you were given.",
  ].join("\n");

  const command = new ConverseCommand({
    modelId: DEFAULT_MODEL_ID,
    system: [{ text: EXTRACTION_SYSTEM_PROMPT }],
    messages: [{ role: "user", content: [{ text: userPrompt }] }],
    inferenceConfig: { maxTokens: 4096 },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outputConfig: {
      textFormat: {
        type: "json_schema",
        structure: {
          jsonSchema: {
            schema: JSON.stringify(HEALTH_EVENTS_JSON_SCHEMA),
            name: "health_events_extraction",
          },
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  });

  const response = await client.send(command);
  const blocks = response.output?.message?.content ?? [];
  const text = blocks
    .map((block) => (block && "text" in block ? block.text ?? "" : ""))
    .join("")
    .trim();
  if (!text) {
    throw new Error("Bedrock extraction returned empty output");
  }
  return JSON.parse(text) as ExtractionResult;
}

const PERSON_SECTION_ORDER = ["self", "mother", "father", "sibling", "grandmother", "grandfather"];

function sectionLabel(person: string): string {
  const normalized = person.trim().toLowerCase();
  if (normalized === "self") return "Self";
  return normalized
    .split(/[\s_]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function sortKey(person: string): [number, string] {
  const normalized = person.trim().toLowerCase();
  const index = PERSON_SECTION_ORDER.indexOf(normalized);
  return [index === -1 ? PERSON_SECTION_ORDER.length : index, normalized];
}

export interface TimelineEventPoint {
  age: number;
  description: string;
  category: HealthEvent["category"];
  subcategory: string | null;
  stillLiving: boolean | null;
}

export interface TimelineRow {
  person: string;
  label: string;
  events: TimelineEventPoint[];
}

export interface AgeTimelineChart {
  title: string;
  minAge: number;
  maxAge: number;
  rows: TimelineRow[];
}

/**
 * Builds one shared-age-axis row per person, each row stacked on top of the
 * next, with every incident plotted at its own age position along that axis
 * (rather than mermaid's `timeline` diagram type, which only lists items
 * sequentially per section with no real numeric axis).
 *
 * An event only gets plotted if it has a known approx_age -- there's no
 * x-position to place it at otherwise. In practice this mostly filters out
 * medications (rarely given a start age/date) and conditions mentioned
 * without an onset age (e.g. "she also had asthma" with no age given): they
 * still show up in the structured health-events list and prose summary,
 * just not on the age axis. This is a deliberate product rule, not a schema
 * limitation -- see the "timeline" section of the README.
 */
export function buildAgeTimeline(events: HealthEvent[], title: string): AgeTimelineChart {
  const plottable = events.filter(
    (event): event is HealthEvent & { approx_age: number } => event.approx_age != null,
  );

  const byPerson = new Map<string, HealthEvent[]>();
  for (const event of plottable) {
    const person = (event.person || "self").trim().toLowerCase();
    if (!byPerson.has(person)) byPerson.set(person, []);
    byPerson.get(person)!.push(event);
  }

  const people = [...byPerson.keys()].sort((a, b) => {
    const [ai, an] = sortKey(a);
    const [bi, bn] = sortKey(b);
    return ai !== bi ? ai - bi : an.localeCompare(bn);
  });

  const rows: TimelineRow[] = people.map((person) => {
    const personEvents = byPerson
      .get(person)!
      .slice()
      .sort((a, b) => (a.approx_age ?? 0) - (b.approx_age ?? 0));
    return {
      person,
      label: sectionLabel(person),
      events: personEvents.map((event) => ({
        age: event.approx_age as number,
        description: event.description,
        category: event.category,
        subcategory: event.subcategory,
        // "still living/deceased" only makes sense for relatives, not the patient themself.
        stillLiving: person === "self" ? null : event.still_living,
      })),
    };
  });

  const ages = plottable.map((event) => event.approx_age as number);
  const maxAge = ages.length ? Math.max(10, Math.ceil((Math.max(...ages) + 5) / 10) * 10) : 100;

  return { title, minAge: 0, maxAge, rows };
}
