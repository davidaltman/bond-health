/**
 * The per-turn extraction pass.
 *
 * One small model call per patient turn. It sees that turn, the question it
 * answered, and a compact view of what's already on file -- never the growing
 * transcript. It returns operations against the ledger plus a fresh read of
 * how the conversation feels.
 *
 * This call is never in the conversational critical path. The prior prototype
 * made mid-call capture an agent tool the LLM waited on, which produced
 * 15-second dead air and duplicate questions (see
 * ../../docs/prior-art-daphne-history-demo.md). Here a slow or failed
 * extraction degrades what the system knows, never what the patient hears.
 */
import { completeJson } from "./llm.js";
import {
  FACT_CATEGORIES,
  FACT_STATUSES,
  CONFIDENCES,
  HESITATIONS,
  READINESS_LEVELS,
  TONES,
  VERBOSITIES,
  type ConversationSignals,
  type ProposedOperation,
} from "./ledger.js";

const SYSTEM_PROMPT = `You maintain the structured memory of a live conversation between a patient
and Daphne, a voice health assistant. You are given the facts already on file,
the question Daphne just asked, and the patient's reply. Return the changes that
reply makes to the record, plus a read of how the patient sounds.

You are a recorder, not a clinician. Never infer a diagnosis, never add a fact
the patient did not state, never turn a worry into a symptom. Every operation
must carry a verbatim source_quote taken from the patient's reply.

OPERATIONS

"add"        a fact not already on file. Requires subject, category, attribute,
             value, status, confidence, source_quote.
"confirm"    the patient restated something already on file. Requires fact_ref.
"refine"     the patient added detail to something on file (an age, a date, a
             dose). Requires fact_ref plus only the fields that changed.
"contradict" the patient corrected something on file. Requires fact_ref and a
             note. Follow it with an "add" carrying the corrected version.

Only contradict when the new statement and the old one cannot both be true.
Filling in a blank, sharpening a vague answer, or adding an age to a fact that
had none is a "refine". "He was 52, not 60" contradicts. "I've never had one",
after a fact that only said the topic came up, refines.

Use fact_ref ids exactly as they appear in the facts-on-file list. If the reply
adds nothing to the record, return an empty operations list -- that is a normal
and common outcome.

Refer to the patient as subject "self", and to relatives by relation
("mother", "father", "uncle"), never by name.

attribute is a short canonical key, lowercase, no dates or ages inside it:
"colonoscopy", "rosacea", "doxycycline", "wrist numbness". value is the readable
detail. Reuse the exact attribute already on file when referring to the same
thing.

STATUS -- read this carefully, it is the field most often gotten wrong.

"active"   the patient has this now
"resolved" the patient had this and it is over
"never"    the patient explicitly stated this has never happened
"unknown"  mentioned but the patient does not know, or they did not say

"never" is only for an explicit stated negative: "I've never had a colonoscopy",
"nobody in my family has had cancer". Record that as an "add" with status
"never" -- it is real information, not an absence. Do not invent a "never" fact
for a topic simply because it has not come up.

SIGNALS

Report how the patient sounds in this reply, not what they said.

readiness is specifically about acting on something concrete, such as booking or
requesting:
  not_raised       no action is on the table yet
  exploring        asking questions about it, not requesting it
  ambivalent       weighing it, voicing hesitation or reluctance
  ready            agreeing in principle
  explicit_request directly asking for it to be done ("can you book it?")

Do not report explicit_request unless the patient actually asked for the action.
Hesitation and agreement in the same turn is ambivalent, not ready.

Output only JSON matching the schema.`;

const TURN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    operations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          op: { type: "string", enum: ["add", "confirm", "refine", "contradict"] },
          fact_ref: { type: ["string", "null"] },
          subject: { type: ["string", "null"] },
          category: { type: ["string", "null"] },
          attribute: { type: ["string", "null"] },
          value: { type: ["string", "null"] },
          onset_age: { type: ["integer", "null"] },
          last_occurred: { type: ["string", "null"] },
          status: { type: ["string", "null"] },
          confidence: { type: ["string", "null"] },
          source_quote: { type: "string" },
          note: { type: ["string", "null"] },
        },
        required: [
          "op",
          "fact_ref",
          "subject",
          "category",
          "attribute",
          "value",
          "onset_age",
          "last_occurred",
          "status",
          "confidence",
          "source_quote",
          "note",
        ],
      },
    },
    signals: {
      type: "object",
      additionalProperties: false,
      properties: {
        tone: { type: "string", enum: TONES },
        hesitation: { type: "string", enum: HESITATIONS },
        readiness: { type: "string", enum: READINESS_LEVELS },
        verbosity: { type: "string", enum: VERBOSITIES },
        sensitive_topics: { type: "array", items: { type: "string" } },
      },
      required: ["tone", "hesitation", "readiness", "verbosity", "sensitive_topics"],
    },
  },
  required: ["operations", "signals"],
};

interface RawTurnExtraction {
  operations: Array<{
    op: "add" | "confirm" | "refine" | "contradict";
    fact_ref: string | null;
    subject: string | null;
    category: string | null;
    attribute: string | null;
    value: string | null;
    onset_age: number | null;
    last_occurred: string | null;
    status: string | null;
    confidence: string | null;
    source_quote: string;
    note: string | null;
  }>;
  signals: {
    tone: string;
    hesitation: string;
    readiness: string;
    verbosity: string;
    sensitive_topics: string[];
  };
}

export interface TurnExtraction {
  operations: ProposedOperation[];
  signals: Omit<ConversationSignals, "turn">;
}

export interface ExtractTurnInput {
  /** Compact ledger view from summarizeForPrompt(). */
  factsOnFile: string;
  /** The agent turn this reply answers, if there was one. */
  precedingAgentTurn: string | null;
  patientTurn: string;
}

function pick<T extends string>(value: string, allowed: T[], fallback: T): T {
  return (allowed as string[]).includes(value) ? (value as T) : fallback;
}

export async function extractTurn(input: ExtractTurnInput): Promise<TurnExtraction> {
  const userPrompt = [
    "FACTS ON FILE",
    input.factsOnFile,
    "",
    "DAPHNE JUST ASKED",
    input.precedingAgentTurn ?? "(nothing -- the patient spoke first)",
    "",
    "PATIENT REPLY",
    input.patientTurn,
  ].join("\n");

  const raw = await completeJson<RawTurnExtraction>({
    system: SYSTEM_PROMPT,
    user: userPrompt,
    schemaName: "turn_extraction",
    schema: TURN_JSON_SCHEMA,
    maxOutputTokens: 4096,
    reasoningEffort: "low",
  });

  // Normalize into the ledger's vocabulary. Anything outside the allowed sets
  // is coerced here rather than trusted, matching the ledger's own approach:
  // the prompt asks, the code guarantees.
  const operations: ProposedOperation[] = (raw.operations ?? []).map((operation) => ({
    op: operation.op,
    factRef: operation.fact_ref,
    subject: operation.subject,
    category:
      operation.category && (FACT_CATEGORIES as string[]).includes(operation.category)
        ? operation.category
        : null,
    attribute: operation.attribute,
    value: operation.value,
    onsetAge: typeof operation.onset_age === "number" ? operation.onset_age : null,
    lastOccurred: operation.last_occurred,
    status:
      operation.status && (FACT_STATUSES as string[]).includes(operation.status) ? operation.status : null,
    confidence:
      operation.confidence && (CONFIDENCES as string[]).includes(operation.confidence)
        ? operation.confidence
        : null,
    sourceQuote: operation.source_quote ?? "",
    note: operation.note,
  }));

  return {
    operations,
    signals: {
      tone: pick(raw.signals?.tone ?? "", TONES, "neutral"),
      hesitation: pick(raw.signals?.hesitation ?? "", HESITATIONS, "none"),
      readiness: pick(raw.signals?.readiness ?? "", READINESS_LEVELS, "not_raised"),
      verbosity: pick(raw.signals?.verbosity ?? "", VERBOSITIES, "normal"),
      sensitiveTopics: Array.isArray(raw.signals?.sensitive_topics) ? raw.signals.sensitive_topics : [],
    },
  };
}
