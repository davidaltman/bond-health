/**
 * LLM-backed semantic judgments for logistics replies, as an alternative to
 * word matching for the parts of preference.ts / escort.ts / shipping.ts
 * that were never actually a fixed vocabulary.
 *
 * Weekdays and time-of-day ("morning", "afternoon") stay regex in
 * preference.ts -- that's a closed set of seven words plus two, and asking a
 * model to reproduce a fixed set turn after turn buys nothing (see that
 * file's own doc comment). But "does this reply mean take the soonest
 * opening," "is this a decline," and "is this a farewell or a request for
 * booking details" are open-ended judgments over phrasing nobody enumerated
 * in advance -- "whatever's easiest," "I'll just grab one myself," "I think
 * that covers it," "who's it with?" -- exactly the case this app already
 * trusts a model for everywhere else (see extract-turn.ts). Keeping them as
 * regex only meant the pattern list kept growing every time a real
 * transcript found a gap it didn't cover.
 *
 * Called from sessions.ts, in parallel with extractTurn via Promise.all,
 * and only when the currently active gate makes the judgment relevant -- on
 * an ordinary clinical-history turn, where none of these apply, this file
 * makes no call at all and adds no latency or cost. On a turn where one
 * does apply, it's one more small structured-output call alongside the one
 * sessions.ts is already making, started at the same time, not after it.
 *
 * Same fallback discipline as elsewhere: a failed or skipped call here never
 * blocks the turn -- callers fall back to the old regex (see
 * preference.ts, escort.ts, shipping.ts, and decide.ts's CLOSING_PATTERN /
 * BOOKING_DETAIL_PATTERN), which is why those patterns are still there
 * instead of deleted.
 */
import { completeJson } from "./llm.js";

const SOONEST_SYSTEM_PROMPT = `A scheduling assistant just asked the patient what day or time works for a
procedure, offering to just grab the soonest opening if they don't have a
preference. Judge only whether THIS reply means "no preference, take the
soonest opening" -- not whether a day or time was also mentioned; a separate,
deterministic step already handles extracting that.

Answer true for anything that amounts to "I don't mind," "whatever's easiest,"
"you pick," "as soon as possible," or a reply that expresses no preference at
all.

Answer false when the reply states an actual day, time of day, or date, even
loosely ("sometime next week," "before I go back to work") -- the patient has
expressed a preference, even if it isn't one of the fixed weekday or time-of-
day words a separate deterministic step recognizes. Also answer false for a
reply that isn't about scheduling at all.

Output only JSON matching the schema.`;

const SOONEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    soonest_ok: { type: "boolean" },
  },
  required: ["soonest_ok"],
};

export interface SoonestJudgment {
  soonestOk: boolean;
}

export async function classifySoonestPreference(input: {
  question: string | null;
  reply: string;
}): Promise<SoonestJudgment> {
  const user = [
    "DAPHNE JUST ASKED",
    input.question ?? "(what day or time works, with an offer to take the soonest opening)",
    "",
    "PATIENT REPLY",
    input.reply,
  ].join("\n");
  const raw = await completeJson<{ soonest_ok: boolean }>({
    system: SOONEST_SYSTEM_PROMPT,
    user,
    schemaName: "soonest_preference",
    schema: SOONEST_SCHEMA,
    maxOutputTokens: 256,
    reasoningEffort: "none",
  });
  return { soonestOk: !!raw.soonest_ok };
}

const DECLINE_SYSTEM_PROMPT = `A scheduling assistant asked the patient a single, non-clinical logistics
question -- either for a pickup contact for after a sedated procedure, or for
a shipping address for a prep kit. Both asks are explicitly non-blocking: a
decline is just as final an answer as providing the thing asked for.

Judge only whether THIS reply is a decline -- the patient saying no, that they
don't have one, that they'll handle it themselves, or anything else that
amounts to "don't send anything." Answer false for anything that actually
supplies what was asked (a name, a relationship, a phone number, an email, an
address), no matter how it's phrased, and false for an empty or unrelated
reply.

Output only JSON matching the schema.`;

const DECLINE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    declined: { type: "boolean" },
  },
  required: ["declined"],
};

export interface DeclineJudgment {
  declined: boolean;
}

export async function classifyDecline(input: {
  askedFor: "escort_contact" | "shipping_address";
  question: string | null;
  reply: string;
}): Promise<DeclineJudgment> {
  const askedForLine =
    input.askedFor === "escort_contact"
      ? "ASKED FOR: a friend or family member who can pick the patient up after the procedure"
      : "ASKED FOR: a shipping address for the prep kit";
  const user = [
    askedForLine,
    "",
    "DAPHNE JUST ASKED",
    input.question ?? "(the ask above)",
    "",
    "PATIENT REPLY",
    input.reply,
  ].join("\n");
  const raw = await completeJson<{ declined: boolean }>({
    system: DECLINE_SYSTEM_PROMPT,
    user,
    schemaName: "logistics_decline",
    schema: DECLINE_SCHEMA,
    maxOutputTokens: 256,
    reasoningEffort: "none",
  });
  return { declined: !!raw.declined };
}

const CLOSING_SYSTEM_PROMPT = `A scheduling assistant already told the patient about their existing
booking or waitlist entry. Judge what THIS reply means.

Answer "closing" if the patient is signaling they're done -- a goodbye, a
plain thank-you with nothing further, or an indication there's nothing else
they need.

Answer "details" if the patient is asking for something about their existing
booking/waitlist itself -- the date, time, clinic, confirmation number, prep
they were already told about, or similar -- even if phrased indirectly
("where am I headed again?", "who's it with?", "remind me when that is",
"what am I supposed to do again before it?").

Answer "other" for anything else -- a new question, a change of topic, or
something that doesn't fit either category.

Output only JSON matching the schema.`;

const CLOSING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: { type: "string", enum: ["closing", "details", "other"] },
  },
  required: ["intent"],
};

export interface ClosingIntentJudgment {
  intent: "closing" | "details" | "other";
}

export async function classifyClosingIntent(input: {
  reply: string;
}): Promise<ClosingIntentJudgment> {
  const raw = await completeJson<{ intent: "closing" | "details" | "other" }>({
    system: CLOSING_SYSTEM_PROMPT,
    user: `PATIENT REPLY\n${input.reply}`,
    schemaName: "closing_intent",
    schema: CLOSING_SCHEMA,
    maxOutputTokens: 256,
    reasoningEffort: "none",
  });
  const intent = raw.intent;
  return {
    intent: intent === "closing" || intent === "details" || intent === "other" ? intent : "other",
  };
}
