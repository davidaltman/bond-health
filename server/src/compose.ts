/**
 * Turning a decision into something Daphne says.
 *
 * The utterance is split in two, and the split is the whole design:
 *
 *   acknowledgment  model-written, tone-adaptive, carries no clinical content
 *   substance       the decision's authored text, verbatim, never rewritten
 *
 * The brief wants an agent that sounds human and an agent that is safe, and
 * those pull in opposite directions if one model writes the whole sentence.
 * Letting an LLM paraphrase "screening begins at 40" produces "screening
 * usually starts around your early forties" eventually, and nobody notices
 * until it matters. Letting a template carry the warmth produces something
 * that reads like a form letter.
 *
 * Splitting them means the model only ever controls how it feels to hear, and
 * the guideline tables control what is claimed. It also makes the safety
 * property testable rather than aspirational: the authored substance must
 * appear in the final utterance character for character, and the eval suite
 * asserts exactly that.
 */
import { completeJson } from "./llm.js";
import type { ConversationSignals } from "./ledger.js";
import type { Decision } from "./decide.js";

const SYSTEM_PROMPT = `You write the opening beat of a health assistant's reply -- the bit that
acknowledges what the patient just said, before the assistant gets to the point.

You are NOT answering them. Something else supplies the actual answer and will
be appended directly after your words. Your job is only to make the patient feel
heard first.

Hard rules:
- At most 18 words. Often the best answer is an empty string.
- No clinical content of any kind: no advice, no reassurance about symptoms, no
  ages, dates, intervals, numbers, or statistics, no promises about what will
  happen next.
- Do not ask a question. Do not repeat back what they said verbatim.
- Do not apologise unless something actually went wrong.
- Plain spoken English. No therapy-speak, no "I understand that must be".

Match the patient's state:
- embarrassed  take the shame out of it, lightly, without dwelling
- worried      steady and brief, do not amplify
- frustrated   acknowledge it plainly, do not over-explain
- rushed       return an empty string, get out of the way
- neutral      usually an empty string

If the patient is simply answering a question, an empty string is right. Filler
after every turn is worse than silence.`;

const ACK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { acknowledgment: { type: "string" } },
  required: ["acknowledgment"],
};

/** Used when the model is unavailable, too slow, or produces something the
 *  guard rejects. Deliberately plain -- a flat acknowledgment is a much smaller
 *  failure than a fluent one that invents clinical content. */
const FALLBACK_ACK: Record<string, string> = {
  embarrassed: "No judgement here at all.",
  worried: "I hear you.",
  frustrated: "That's fair.",
  rushed: "",
  neutral: "",
};

export interface ComposedReply {
  text: string;
  acknowledgment: string;
  substance: string;
  /** Set when the model's acknowledgment was rejected, for the review pane. */
  guardTripped: string | null;
}

/**
 * Rejects anything that strays out of its lane.
 *
 * Digits are banned outright, which is blunt but catches the whole dangerous
 * class at once: ages, intervals, dosages, dates, confirmation numbers. An
 * acknowledgment never needs a number, so the false-positive cost is zero.
 */
function guard(candidate: string): string | null {
  const text = candidate.trim();
  if (!text) return null;
  if (/\d/.test(text)) return "contained a number";
  if (text.split(/\s+/).length > 18) return "too long";
  if (/\?/.test(text)) return "asked a question";
  if (/\b(should|recommend|advise|diagnos|prescrib|dose|dosage|risk|cancer|symptom)\w*/i.test(text)) {
    return "contained clinical content";
  }
  return null;
}

export async function composeReply(options: {
  decision: Decision;
  signals: ConversationSignals | null;
  patientTurn: string;
}): Promise<ComposedReply> {
  const substance = options.decision.say.trim();
  const tone = options.signals?.tone ?? "neutral";

  // A booking confirmation and a refusal both stand on their own. Prefacing
  // "You're booked" with a warm noise reads as padding.
  const wantsAcknowledgment =
    options.decision.outcome !== "ACT" && (tone !== "neutral" || options.signals?.hesitation !== "none");

  let acknowledgment = "";
  let guardTripped: string | null = null;

  if (wantsAcknowledgment) {
    try {
      const result = await completeJson<{ acknowledgment: string }>({
        system: SYSTEM_PROMPT,
        user: [
          `Patient tone: ${tone}`,
          `Hesitation: ${options.signals?.hesitation ?? "none"}`,
          `They just said: ${options.patientTurn}`,
          "",
          "Write only the acknowledgment.",
        ].join("\n"),
        schemaName: "acknowledgment",
        schema: ACK_SCHEMA,
        maxOutputTokens: 256,
        reasoningEffort: "low",
      });
      const candidate = (result.acknowledgment ?? "").trim();
      guardTripped = guard(candidate);
      acknowledgment = guardTripped ? (FALLBACK_ACK[tone] ?? "") : candidate;
    } catch (error) {
      guardTripped = error instanceof Error ? error.message : String(error);
      acknowledgment = FALLBACK_ACK[tone] ?? "";
    }
  }

  return {
    text: [acknowledgment, substance].filter(Boolean).join(" "),
    acknowledgment,
    substance,
    guardTripped,
  };
}
