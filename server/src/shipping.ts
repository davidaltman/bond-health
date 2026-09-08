/**
 * Deterministic parsing of the prep-kit shipping address.
 *
 * Same rationale as escort.ts, and the same non-blocking design: this is
 * logistics, not a clinical fact, and asking for it must never become a
 * reason to loop. A decline ("I'll just grab one at the pharmacy," "I
 * already have one") is exactly as final as a real address -- a patient
 * managing their own prep kit is a normal outcome, not a gap to escalate.
 * See decide.ts's "shipping" gate.
 *
 * The decline judgment itself ("I already have one," "I'll just grab one at
 * the pharmacy") has no fixed vocabulary, so it's made by an LLM call in
 * logistics-llm.ts, run from sessions.ts in parallel with the turn's
 * extraction call. DECLINE_PATTERN below is only the fallback for when that
 * call fails or wasn't made.
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

/**
 * Command/lead-in phrases that precede the actual address ("Send it to
 * 124 Main St" -> "124 Main St"), plus the same backchannel words escort.ts
 * already strips. Distinct from escort.ts's LEADING_FILLER_PATTERN, which
 * only covers yeah/um/sure -- this also strips imperative shipping phrases
 * ("send/ship/mail it to", "address is", "it's"). Filler words are
 * word-bounded so "South Main" / "Oklahoma" / "Wellington" are not eaten.
 *
 * Incomplete by design: a phrase list will miss some phrasings. That's the
 * same accepted tradeoff as escort.ts's filler list, not a reason to route
 * this through an LLM -- logistics-llm.ts is for open-ended judgment ("is
 * this a decline?"), not stripping a common lead-in. Real transcript that
 * found this: "Send it to 124 Happy Lane, London, England."
 */
const LEADING_COMMAND_PATTERN =
  /^(?:(?:yeah|yep|yes|sure|okay|ok|well|um+|uh+|so|alright|hmm+)\b[\s,]*)*(?:(?:you can |please )?(?:send|ship|mail) (?:it |the (?:kit|prep kit) )?to\s+|address is\s+|it'?s\s+)?/i;

/**
 * Display-only trim of the patient's shipping reply for use in a sentence
 * like "Your prep kit ships to {line}". The full raw reply is the audit
 * record -- this is the short form spoken back, same split as escort.ts's
 * label vs raw. Strips leading command phrases and trailing sentence
 * punctuation; does not try to validate that what remains is an address.
 * Exported so scripts/test_shipping.mjs can pin the live-transcript case
 * without going through a session.
 */
export function deriveShippingLine(raw: string): string {
  const withoutLeadIn = raw.replace(LEADING_COMMAND_PATTERN, "").trim();
  const candidate = withoutLeadIn || raw;
  return candidate.replace(/[.\s]+$/, "");
}

/**
 * `declineJudgment` is the LLM's read on whether this reply is a decline
 * (see logistics-llm.ts's classifyDecline), passed in by the caller when
 * that call was made and succeeded. Pass null to fall back to
 * DECLINE_PATTERN, e.g. when the call errored.
 */
export function parseShippingAddress(raw: string, declineJudgment: boolean | null = null): ShippingAddress {
  const trimmed = raw.trim();
  if (!trimmed) return { provided: false, raw: trimmed };
  const declined = declineJudgment ?? DECLINE_PATTERN.test(trimmed);
  if (declined) return { provided: false, raw: trimmed };
  return { provided: true, raw: trimmed };
}
