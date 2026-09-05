/**
 * Parsing a scheduling preference from free text, deterministically.
 *
 * This is logistics, not clinical history, so it doesn't belong in the fact
 * ledger -- it never needs a source quote, a confidence, or a lifecycle, and
 * mixing it into ClinicalFact would blur exactly the line that file exists to
 * draw.
 *
 * It also doesn't need a model call. The vocabulary is small and fixed --
 * seven weekdays, two parts of day, a handful of ways to say "whatever's
 * soonest" -- which is precisely the case for encoding it in code rather than
 * asking a model to reproduce the same fixed set turn after turn. Same
 * principle as requirements.ts's slot vocabulary, applied to a simpler
 * problem.
 */

export type TimeOfDay = "morning" | "afternoon";

export interface SchedulingPreference {
  raw: string;
  /** 0 = Sunday .. 6 = Saturday. */
  dayOfWeek: number | null;
  timeOfDay: TimeOfDay | null;
  /** Patient explicitly doesn't mind, or asked for the earliest opening. */
  soonest: boolean;
}

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

// "as soon as" (not "as soon as possible") deliberately, so it also catches
// "as soon as you can" and "as soon as you're able" -- the phrase people
// actually say, not the canonical form of it.
//
// Unambiguous: these only ever mean "I have no preference, take the soonest
// opening." Checked regardless of anything else in the reply.
const UNAMBIGUOUS_SOONEST_PATTERN =
  /\bas soon as\b|\basap\b|\bsoonest\b|\bearliest\b|\bwhenever\b|\bany ?time\b|\bno preference\b|don'?t care|doesn'?t matter/i;

// Ambiguous: these read as "no preference" on their own ("whatever works"),
// but also as a plain affirmation of a day/time just stated in the same
// breath ("Wednesday afternoon works for me"). Only treated as "soonest" when
// no day or time was actually named -- otherwise they'd silently override the
// exact thing the patient just said, which is worse than not recognizing a
// preference at all.
const AMBIGUOUS_SOONEST_PATTERN = /\byou pick\b|\bup to you\b|works for me|whatever works/i;

/**
 * Returns null only when the reply carries no scheduling signal at all -- the
 * caller treats that as "still waiting to hear a preference," not as
 * "patient doesn't care." Those are different things, in the same way a
 * missing fact and a fact with status "never" are different things elsewhere
 * in this codebase: silence is not an answer.
 */
export function parseSchedulingPreference(text: string): SchedulingPreference | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // "s" suffix so "fridays" (a very natural way to answer "what day works")
  // matches, not just the exact singular "friday".
  const dayOfWeek = WEEKDAYS.findIndex((day) => new RegExp(`\\b${day}s?\\b`, "i").test(trimmed));
  // "after noon" as two words is a common, deliberate way people write/say
  // "afternoon" -- worth matching on its own, not just as a typo of the
  // one-word form.
  const timeOfDay: TimeOfDay | null = /\bmornings?\b/i.test(trimmed)
    ? "morning"
    : /\bafternoons?\b|\bafter\s+noon\b|\bevenings?\b/i.test(trimmed)
      ? "afternoon"
      : null;
  const namedSomething = dayOfWeek !== -1 || timeOfDay !== null;

  const soonest =
    UNAMBIGUOUS_SOONEST_PATTERN.test(trimmed) || (!namedSomething && AMBIGUOUS_SOONEST_PATTERN.test(trimmed));

  if (!soonest && !namedSomething) return null;

  return { raw: trimmed, dayOfWeek: dayOfWeek === -1 ? null : dayOfWeek, timeOfDay, soonest };
}

/** Patient-facing description, used when the scheduler couldn't match the
 *  request exactly and needs to say what it tried to match. */
export function describePreference(preference: SchedulingPreference): string {
  if (preference.soonest) return "the soonest opening";
  const parts: string[] = [];
  if (preference.dayOfWeek != null) {
    const day = WEEKDAYS[preference.dayOfWeek];
    parts.push(day.charAt(0).toUpperCase() + day.slice(1));
  }
  if (preference.timeOfDay) parts.push(preference.timeOfDay);
  return parts.length ? parts.join(" ") : "your preference";
}
