/**
 * LLM-backed detection of red-flag symptoms in a patient's reply to the
 * authored safety question, as an alternative to regex-matching an
 * open-ended vocabulary that can never be enumerated.
 *
 * requirements.ts's SLOT_MATCHERS table works for procedure-name variance
 * ("colonoscopy" is a genuinely small closed set), but "is there blood" is
 * not: patients say bleeding, spotting, streaks, blood when wiping, dark or
 * tarry stools -- there is no finite phrase list. A real transcript already
 * found the gap this file exists to close: "Yeah, I've had bleeding."
 * matched nothing in the old regex, and the safety gate kept re-asking the
 * identical question. This call asks the model to make that open-ended
 * judgment directly, the same split this app already uses for closing vs.
 * details, decline, and soonest-preference (see logistics-llm.ts) -- just
 * for a clinical-safety judgment rather than a scheduling-logistics one,
 * which is why it lives in its own file instead of that one.
 *
 * Called from sessions.ts, in parallel with extractTurn via Promise.all,
 * and only on the turn right after decide() asked RED_FLAG_QUESTION (see
 * requirements.ts) -- an ordinary clinical-history turn makes no call here
 * and pays no latency or cost for it. gpt-5.4-mini with reasoning effort
 * "none" (the lowest this model accepts, see llm.ts): this is a small,
 * closed-vocabulary read on one short reply, not a task that benefits from
 * extra reasoning tokens.
 *
 * Its result becomes ordinary ProposedOperation entries, merged with
 * extractTurn's own in sessions.ts before either reaches the ledger.
 * decide() itself never calls out and keeps reading only ledger slots via
 * requirements.ts's redFlagSlotForCanonicalAttribute -- same as every other
 * fact, so this file adds a source of facts, not a new code path in
 * decide().
 *
 * Same fallback discipline as elsewhere: a failed or skipped call here
 * degrades to extractTurn's own, more general symptom handling (see
 * extract-turn.ts's "AFFIRMATIONS OF SYMPTOMS ARE FACTS TOO" instruction and
 * requirements.ts's RED_FLAG_FALLBACK_PATTERNS) -- this is not the only path
 * to a red-flag fact reaching the record, just the reliable one for the
 * specific moment it matters most.
 */
import { completeJson } from "./llm.js";
import { RED_FLAG_SLOTS, type RedFlagSlot } from "./requirements.js";

/** Re-exported under this file's own naming for callers that only care
 *  about the LLM-judgment side; RED_FLAG_SLOTS/RedFlagSlot in requirements.ts
 *  remain the single source of truth for the actual four strings. */
export type RedFlagKey = RedFlagSlot;

const RED_FLAG_SYSTEM_PROMPT = `A scheduling assistant just asked the patient this safety question: "Any
bleeding, unexplained weight loss, or changes in your bowel habits?" Judge
which of those THIS reply affirms as something the patient currently has or
recently had.

Affirm rectal_bleeding for any mention of blood in the stool, spotting,
streaks, blood when wiping, dark or tarry stools, mucus with blood, or a
plain "yes" / "bleeding" answering this question -- not blood pressure and
not a blood test.

Affirm unexplained_weight_loss for losing weight without trying, clothes
fitting looser, or dropping pounds -- not weight lost on purpose.

Affirm bowel_habit_change for new or worsening constipation, diarrhea,
narrower stools, or alternating between the two.

Affirm iron_deficiency_anemia for anemia, low iron, or an iron deficiency
finding.

Return every one of the four that applies -- a single reply can affirm more
than one, or none at all. A plain denial ("no", "nope", "none of that") or a
reply about something else entirely affirms nothing; return an empty list.

Output only JSON matching the schema.`;

const RED_FLAG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    flags: {
      type: "array",
      items: { type: "string", enum: [...RED_FLAG_SLOTS] },
    },
  },
  required: ["flags"],
};

export interface RedFlagJudgment {
  flags: RedFlagKey[];
}

export async function classifyRedFlagSymptoms(input: { reply: string }): Promise<RedFlagJudgment> {
  const raw = await completeJson<{ flags: string[] }>({
    system: RED_FLAG_SYSTEM_PROMPT,
    user: `PATIENT REPLY\n${input.reply}`,
    schemaName: "red_flag_symptoms",
    schema: RED_FLAG_SCHEMA,
    maxOutputTokens: 256,
    reasoningEffort: "none",
  });
  const flags = Array.isArray(raw.flags) ? raw.flags : [];
  return {
    flags: flags.filter((flag): flag is RedFlagKey => (RED_FLAG_SLOTS as string[]).includes(flag)),
  };
}
