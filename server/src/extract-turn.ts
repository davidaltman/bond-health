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
 * 15-second dead air and duplicate questions (see this project's
 * agent-config commit history for the incident write-up). Here a slow or
 * failed extraction degrades what the system knows, never what the patient
 * hears.
 */
import { completeJson } from "./llm.js";
import {
  FACT_CATEGORIES,
  FACT_STATUSES,
  CONFIDENCES,
  HESITATIONS,
  READINESS_LEVELS,
  REQUEST_TYPES,
  TONES,
  VERBOSITIES,
  type ConversationSignals,
  type FactStatus,
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

A contradict is always followed by an "add" for the corrected version, and
that add's own status describes what was just said, never the status of the
fact being corrected. "Nobody in my family has had that" (status "never")
followed later by "actually, my mom had polyps" contradicts the family denial
and adds a fact about the mother -- with status "unknown" unless the reply
says whether it's ongoing or resolved. Do not carry "never" over into the new
fact just because it is replacing one; the patient is affirming something
happened, which "never" can never mean.

Use fact_ref ids exactly as they appear in the facts-on-file list. If the reply
adds nothing to the record, return an empty operations list -- that is a normal
and common outcome.

Refer to the patient as subject "self", and to relatives by relation
("mother", "father", "uncle"), never by name. Use subject "family" for a
statement about the family collectively, including a denial: "nobody in my
family has had colon cancer" is subject "family" with status "never", not a
fact about the patient.

A reply that names one specific parent's side ("nothing on my mom's side",
"my dad's side is clear") is about that parent only -- subject "mother" or
"father" respectively -- not "family". "Family" is reserved for a statement
that names no side at all ("nobody in my family", "no history that I know
of"). Getting this wrong silently marks a question about the other parent as
already answered when it was never actually addressed.

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

DENIALS ARE FACTS. If Daphne just asked about something and the patient says no,
you must record it. "No bleeding, no weight loss, nothing like that" in answer
to a symptom question is three separate "add" operations with status "never",
not an empty operations list. Returning nothing there loses the answer and
Daphne will ask again. Answering a question about several things at once
produces one operation per thing.

A request is not a fact. "Can you book it for me" tells us what the patient
wants, which is carried by request_type below, and must not become a clinical
fact about a procedure they have had.

A day, time, or scheduling preference is not a clinical fact either. "Tuesday
morning works" or "as soon as possible" answers a logistics question, not a
clinical one -- it has no subject, no attribute, no status in this domain, and
must produce no operation at all. If a reply mixes the two -- "Tuesday
morning, and I should also mention I've been having some cramping" -- record
only the clinical half.

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

request_type is what the patient is asking of us in this turn:
  none              they are answering or sharing, not asking
  information       a factual or logistical question ("how long does it take?")
  action            asking us to do something ("book it", "send me that")
  clinical_judgment asking for a diagnosis, an interpretation of a symptom or
                    result, a medication or dose, or whether they should be
                    worried

Report clinical_judgment whenever the honest answer would require medical
judgement about this specific patient, even if it is phrased casually.

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
        request_type: { type: "string", enum: REQUEST_TYPES },
        sensitive_topics: { type: "array", items: { type: "string" } },
      },
      required: ["tone", "hesitation", "readiness", "verbosity", "request_type", "sensitive_topics"],
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
    request_type: string;
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

/** Any of the ordinary ways a reply states an explicit negative. */
const NEGATION_PATTERN =
  /\b(no|not|never|none|nobody|nothing|neither|denies?|denying|didn't|doesn't|hasn't|haven't|isn't|wasn't)\b/i;

/**
 * "never" is only ever correct when the quote itself actually negates
 * something -- that is the whole definition the prompt gives it. Observed in
 * practice: correcting a denial ("nobody in my family has had that" /
 * "actually, my mom had polyps") sometimes produced an "add" that copied
 * "never" over from the fact being contradicted instead of describing what
 * was just affirmed, which is backwards -- the patient is stating something
 * happened. Rather than trust the model to never make this mistake again, an
 * "add" claiming "never" without a negation word in its own source quote is
 * downgraded to "unknown", which is always a safe fallback (it costs an extra
 * ask; a wrong "never" costs a fact silently going missing).
 */
function coerceStatus(op: string, status: FactStatus | null, sourceQuote: string): FactStatus | null {
  if (op === "add" && status === "never" && !NEGATION_PATTERN.test(sourceQuote)) {
    return "unknown";
  }
  return status;
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
    status: coerceStatus(
      operation.op,
      operation.status && (FACT_STATUSES as string[]).includes(operation.status)
        ? (operation.status as FactStatus)
        : null,
      operation.source_quote ?? "",
    ),
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
      requestType: pick(raw.signals?.request_type ?? "", REQUEST_TYPES, "none"),
      sensitiveTopics: Array.isArray(raw.signals?.sensitive_topics) ? raw.signals.sensitive_topics : [],
    },
  };
}
