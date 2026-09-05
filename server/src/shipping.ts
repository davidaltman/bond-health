/**
 * Deterministic parsing of the prep-kit shipping address.
 *
 * Same rationale as escort.ts, and the same non-blocking design: this is
 * logistics, not a clinical fact, and asking for it must never become a
 * reason to loop. A decline ("I'll just grab one at the pharmacy," "I
 * already have one") is exactly as final as a real address -- a patient
 * managing their own prep kit is a normal outcome, not a gap to escalate.
 * See decide.ts's "shipping" gate.
 */

export interface ShippingAddress {
  /** False for an explicit decline or an empty/skipped reply. True for
   *  everything else -- this module does not try to validate that what was
   *  said is actually a deliverable address, same as escort.ts doesn't try
   *  to validate a name. */
  provided: boolean;
  /** Verbatim, whatever the patient said. There's no address-validation
   *  service here, so the raw text *is* the record -- good enough for a
   *  mocked shipment, which is all this ever creates. */
  raw: string;
}

const DECLINE_PATTERN =
  /\b(no\s*(thanks|need)?|none|n\/?a|already have (one|it)|got (one|it)|get my own|pick (it|one) up (myself|at)?|pharmacy|skip|don'?t need)\b/i;

export function parseShippingAddress(raw: string): ShippingAddress {
  const trimmed = raw.trim();
  if (!trimmed || DECLINE_PATTERN.test(trimmed)) {
    return { provided: false, raw: trimmed };
  }
  return { provided: true, raw: trimmed };
}
