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

function deriveLabel(raw: string): string {
  const boundary = raw.search(/[,.;]|\b(?:his|her|their)\s+(?:cell|number|phone)\b/i);
  const label = boundary > 0 ? raw.slice(0, boundary) : raw;
  return label.trim() || raw.trim();
}

export function parseEscortReply(raw: string): EscortContact {
  const trimmed = raw.trim();
  const phoneMatch = trimmed.match(PHONE_PATTERN);
  if (DECLINE_PATTERN.test(trimmed)) {
    return { provided: false, raw: trimmed, phone: null, label: "" };
  }
  return {
    provided: !!trimmed,
    raw: trimmed,
    phone: phoneMatch ? phoneMatch[0] : null,
    label: deriveLabel(trimmed),
  };
}
