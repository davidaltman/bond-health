/**
 * Deterministic parsing of the post-procedure pickup contact.
 *
 * Colonoscopy uses sedation, so the patient cannot drive themselves home --
 * `scheduler.ts`'s prep instructions already say so. This module exists to
 * ask who can be there for that, once, and to make sense of whatever comes
 * back without a model call, same rationale as preference.ts: this is
 * logistics, not a clinical fact, and it must never become a reason to loop.
 *
 * Unlike a day/time preference, there is no "didn't understand" outcome here.
 * Per this app's explicit design, the ask is never blocking -- a decline, a
 * name, or an unparseable mumble are all just as final as each other. See
 * decide.ts's "escort" gate.
 *
 * The decline judgment itself ("no one," "I'll figure it out," "not really")
 * has no fixed vocabulary, so it's made by an LLM call in logistics-llm.ts,
 * run from sessions.ts in parallel with the turn's extraction call.
 * DECLINE_PATTERN below is only the fallback for when that call fails or
 * wasn't made. Phone and email extraction stay regex either way -- those
 * really are fixed-shape patterns, not judgment calls.
 */

export interface EscortContact {
  /** False for an explicit decline ("no one," "I'll figure it out") or an
   *  empty/skipped reply. True for everything else -- this module does not
   *  try to judge whether what was said actually names a real person. */
  provided: boolean;
  /** Verbatim, whatever the patient said. There's no contact book to resolve
   *  a name against, so the raw text *is* the record -- good enough for a
   *  mocked invite, which is all this ever sends. */
  raw: string;
  /** Best-effort phone number extraction, so the mock invite has something
   *  address-shaped to point at. Null if none was stated. */
  phone: string | null;
  /** Best-effort email extraction. Preferred over a name-derived label when
   *  present -- see deriveLabel -- since it's the one unambiguous answer to
   *  "where did the invite actually go." Null if none was stated. */
  email: string | null;
  /** A short, display-friendly trim of `raw` for use in a sentence like
   *  "I've sent a calendar invite to {label}" -- the full raw reply reads
   *  fine on its own but badly mid-sentence ("...to My husband Mark can pick
   *  me up, his cell is 555-..."). Best-effort only, cutting at the first
   *  clause boundary; falls back to the full raw text when there's nothing
   *  to cut. Display only -- `raw` remains the actual record. */
  label: string;
}

const DECLINE_PATTERN =
  /\b(no\s*one|nobody|none|n\/?a|don'?t have (anyone|one)|not sure|skip|by myself|myself|alone|figure it out)\b/i;

const PHONE_PATTERN = /(\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/;
const EMAIL_PATTERN = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/;

/**
 * Backchannel words ("Yeah,", "Um,", "Sure,") that precede the actual
 * answer. Without stripping these first, the clause-boundary search below
 * treats the comma after "Yeah," as the end of the label, and everything
 * that was actually said -- a name, a relationship, an email -- never gets
 * read. Real transcript that found this: "Yeah, you can send an email to
 * myfriend@gmail.com" used to derive the label "Yeah". Applied repeatedly
 * since these often stack ("Yeah, um, ...").
 */
const LEADING_FILLER_PATTERN = /^(?:(?:yeah|yep|yes|sure|okay|ok|well|um+|uh+|so|alright|hmm+)[\s,]*)+/i;

function deriveLabel(raw: string, email: string | null): string {
  // An email is the most concrete, unambiguous answer to "who did the
  // invite go to" -- prefer it outright over a fuzzy name extraction,
  // rather than risk exactly the "Yeah" bug this function used to have.
  if (email) return email;
  const stripped = raw.replace(LEADING_FILLER_PATTERN, "").trim();
  const candidate = stripped || raw;
  const boundary = candidate.search(/[,.;]|\b(?:his|her|their)\s+(?:cell|number|phone)\b/i);
  const label = boundary > 0 ? candidate.slice(0, boundary) : candidate;
  return label.trim() || candidate.trim();
}

/**
 * `declineJudgment` is the LLM's read on whether this reply is a decline
 * (see logistics-llm.ts's classifyDecline), passed in by the caller when
 * that call was made and succeeded. Pass null to fall back to
 * DECLINE_PATTERN, e.g. when the call errored.
 */
export function parseEscortReply(raw: string, declineJudgment: boolean | null = null): EscortContact {
  const trimmed = raw.trim();
  const phoneMatch = trimmed.match(PHONE_PATTERN);
  const emailMatch = trimmed.match(EMAIL_PATTERN);
  const declined = declineJudgment ?? DECLINE_PATTERN.test(trimmed);
  if (declined) {
    return { provided: false, raw: trimmed, phone: null, email: null, label: "" };
  }
  return {
    provided: !!trimmed,
    raw: trimmed,
    phone: phoneMatch ? phoneMatch[0] : null,
    email: emailMatch ? emailMatch[0] : null,
    label: deriveLabel(trimmed, emailMatch ? emailMatch[0] : null),
  };
}
