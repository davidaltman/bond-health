/**
 * The clinical memory this app decides from.
 *
 * Two stores with a one-way wall between them. `ClinicalFact` is the record:
 * atomic, patient-stated, always carrying a verbatim quote. `ConversationSignals`
 * is how the conversation feels right now: tone, hesitation, readiness. A signal
 * can never become a fact. "She sounded worried about the prep" is not
 * "patient reports anxiety", and nothing in this file provides a path from one
 * to the other.
 *
 * The single most important distinction here is `status: "never"` versus the
 * absence of a fact. "I've never had a colonoscopy" is information and can be
 * acted on. No colonoscopy fact at all means we are ignorant and must ask.
 * A post-call transcript extractor collapses both into a missing row; keeping
 * them apart is what lets the decision layer know what it doesn't know.
 *
 * See ../../docs/phase-1-spec.md.
 */

export type FactCategory =
  | "condition"
  | "symptom"
  | "medication"
  | "procedure"
  | "screening"
  | "family_history"
  | "allergy";

export const FACT_CATEGORIES: FactCategory[] = [
  "condition",
  "symptom",
  "medication",
  "procedure",
  "screening",
  "family_history",
  "allergy",
];

/** `never` is load-bearing: it is a stated negative, not missing data. */
export type FactStatus = "active" | "resolved" | "never" | "unknown";
export const FACT_STATUSES: FactStatus[] = ["active", "resolved", "never", "unknown"];

export type Confidence = "high" | "medium" | "low";
export const CONFIDENCES: Confidence[] = ["high", "medium", "low"];

export type FactState = "asserted" | "confirmed" | "contradicted" | "superseded";

export type Provenance = "patient_stated" | "document_upload";

export interface FactQualifiers {
  onsetAge: number | null;
  /** Free text as the patient framed it, e.g. "about 8 years ago". Not parsed
   *  into a date on purpose -- inventing precision the patient didn't give is
   *  exactly the kind of thing this ledger exists to prevent. */
  lastOccurred: string | null;
  status: FactStatus;
}

export interface ClinicalFact {
  id: string;
  subject: string;
  category: FactCategory;
  /** Canonical short key used for identity, e.g. "colonoscopy". */
  attribute: string;
  value: string;
  qualifiers: FactQualifiers;
  confidence: Confidence;
  provenance: Provenance;
  sourceQuote: string;
  firstTurn: number;
  lastTurn: number;
  state: FactState;
  /** Set when a later statement replaced this one. */
  supersededBy: string | null;
  contradictionNote: string | null;
}

export type Tone = "neutral" | "worried" | "frustrated" | "embarrassed" | "rushed";
export const TONES: Tone[] = ["neutral", "worried", "frustrated", "embarrassed", "rushed"];

export type Hesitation = "none" | "mild" | "strong";
export const HESITATIONS: Hesitation[] = ["none", "mild", "strong"];

/** Read by the Phase 2 act/ask gate. Booking requires `explicit_request`;
 *  `ambivalent` blocks it however complete the facts are. */
export type Readiness = "not_raised" | "exploring" | "ambivalent" | "ready" | "explicit_request";
export const READINESS_LEVELS: Readiness[] = [
  "not_raised",
  "exploring",
  "ambivalent",
  "ready",
  "explicit_request",
];

export type Verbosity = "brief" | "normal" | "detailed";
export const VERBOSITIES: Verbosity[] = ["brief", "normal", "detailed"];

export interface ConversationSignals {
  turn: number;
  tone: Tone;
  hesitation: Hesitation;
  readiness: Readiness;
  verbosity: Verbosity;
  sensitiveTopics: string[];
}

// ---------------------------------------------------------------------------
// Operations. The model proposes; this module disposes.
// ---------------------------------------------------------------------------

export interface ProposedOperation {
  op: "add" | "confirm" | "refine" | "contradict";
  /** Existing fact id for confirm/refine/contradict. */
  factRef: string | null;
  subject: string | null;
  category: string | null;
  attribute: string | null;
  value: string | null;
  onsetAge: number | null;
  lastOccurred: string | null;
  status: string | null;
  confidence: string | null;
  sourceQuote: string;
  note: string | null;
}

export type AppliedOutcome =
  | "added"
  | "confirmed"
  | "refined"
  | "contradicted"
  /** An `add` for a subject:attribute already on file, rewritten as a merge. */
  | "coerced_to_merge"
  | "rejected";

export interface AppliedOperation {
  outcome: AppliedOutcome;
  factId: string | null;
  proposedOp: ProposedOperation["op"];
  detail: string;
}

export interface LedgerState {
  facts: ClinicalFact[];
  nextFactSeq: number;
}

export function createLedger(): LedgerState {
  return { facts: [], nextFactSeq: 1 };
}

/**
 * Collapses the many ways a model refers to a person into one vocabulary.
 *
 * The patient is always "self". Left alone, the same model calls them "self",
 * "patient", and "me" across three turns of one call, which splits one person's
 * record into three and makes every downstream consumer -- guideline rules, the
 * act/ask gate, the review pane -- do fuzzy matching to work out whose fact it
 * is. Names are deliberately not mapped: "Ellen" could just as easily be a
 * sister as the patient.
 */
const SUBJECT_ALIASES: Record<string, string> = {
  self: "self",
  patient: "self",
  me: "self",
  i: "self",
  myself: "self",
  "the patient": "self",
  user: "self",
  mom: "mother",
  mum: "mother",
  mother: "mother",
  dad: "father",
  father: "father",
  grandma: "grandmother",
  grandmother: "grandmother",
  grandpa: "grandfather",
  grandfather: "grandfather",
};

export function canonicalSubject(subject: string): string {
  const normalized = normalizeToken(subject).replace(/^my\s+/, "");
  return SUBJECT_ALIASES[normalized] ?? normalized ?? "self";
}

/** Identity key. Two statements about the same attribute of the same person are
 *  the same fact, however differently the model phrases them the second time. */
function identityKey(subject: string, attribute: string): string {
  return `${canonicalSubject(subject)}:${normalizeToken(attribute)}`;
}

function normalizeToken(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ");
}

/** Contradicted and superseded facts stay in the ledger for the audit trail but
 *  are invisible to identity matching and to anything making a decision. */
function isLive(fact: ClinicalFact): boolean {
  return fact.state === "asserted" || fact.state === "confirmed";
}

export function liveFacts(ledger: LedgerState): ClinicalFact[] {
  return ledger.facts.filter(isLive);
}

function findByIdentity(ledger: LedgerState, subject: string, attribute: string): ClinicalFact | undefined {
  const key = identityKey(subject, attribute);
  return ledger.facts.find((fact) => isLive(fact) && identityKey(fact.subject, fact.attribute) === key);
}

function findById(ledger: LedgerState, id: string): ClinicalFact | undefined {
  return ledger.facts.find((fact) => fact.id === id);
}

function oneOf<T extends string>(value: string | null, allowed: T[], fallback: T): T {
  if (value && (allowed as string[]).includes(value)) return value as T;
  return fallback;
}

/**
 * Anything about someone other than the patient is family history, whatever the
 * model called it.
 *
 * Left to the prompt, the same statement about a father's colon cancer comes
 * back as "condition" on one run and "screening" on the next. Phase 2's
 * guideline rules key off category to decide things like earlier screening
 * ages, so a coin-flip here would make those rules fire intermittently. The
 * subject already tells us the answer, so we don't need to ask.
 */
function resolveCategory(subject: string, proposed: string | null): FactCategory {
  if (subject !== "self") return "family_history";
  return oneOf<FactCategory>(proposed, FACT_CATEGORIES, "condition");
}

/**
 * Applies model-proposed operations to the ledger, in order.
 *
 * Every rule that has to hold reliably lives here rather than in the prompt.
 * The prompt asks for good proposals; this function guarantees the invariants:
 * no duplicate subject:attribute, no reference to a fact that doesn't exist,
 * no silent drop without a recorded reason.
 */
export function applyOperations(
  ledger: LedgerState,
  operations: ProposedOperation[],
  turn: number,
): AppliedOperation[] {
  const applied: AppliedOperation[] = [];
  // A correction arrives as contradict-then-add. Remembering what was just
  // retired lets the replacement link back to it, so the record shows a
  // correction chain rather than two unrelated events.
  const retiredThisTurn = new Map<string, ClinicalFact>();

  for (const operation of operations) {
    const quote = (operation.sourceQuote || "").trim();

    if (operation.op === "add") {
      const subject = canonicalSubject(operation.subject || "self") || "self";
      const attribute = (operation.attribute || "").trim();
      if (!attribute || !quote) {
        applied.push({
          outcome: "rejected",
          factId: null,
          proposedOp: "add",
          detail: "add is missing an attribute or a source quote",
        });
        continue;
      }

      // Dedup is enforced here, not trusted to the model.
      const existing = findByIdentity(ledger, subject, attribute);
      if (existing) {
        mergeInto(existing, operation, turn, quote);
        applied.push({
          outcome: "coerced_to_merge",
          factId: existing.id,
          proposedOp: "add",
          detail: `already on file as ${existing.id} (${subject}:${attribute}), merged instead of duplicated`,
        });
        continue;
      }

      const fact: ClinicalFact = {
        id: `f${ledger.nextFactSeq++}`,
        subject,
        category: resolveCategory(subject, operation.category),
        attribute,
        value: (operation.value || attribute).trim(),
        qualifiers: {
          onsetAge: typeof operation.onsetAge === "number" ? operation.onsetAge : null,
          lastOccurred: operation.lastOccurred,
          status: oneOf<FactStatus>(operation.status, FACT_STATUSES, "unknown"),
        },
        confidence: oneOf<Confidence>(operation.confidence, CONFIDENCES, "medium"),
        provenance: "patient_stated",
        sourceQuote: quote,
        firstTurn: turn,
        lastTurn: turn,
        state: "asserted",
        supersededBy: null,
        contradictionNote: null,
      };
      const retired = retiredThisTurn.get(identityKey(subject, attribute));
      if (retired) retired.supersededBy = fact.id;

      ledger.facts.push(fact);
      applied.push({
        outcome: "added",
        factId: fact.id,
        proposedOp: "add",
        detail: retired ? `${subject}: ${fact.value} (replaces ${retired.id})` : `${subject}: ${fact.value}`,
      });
      continue;
    }

    // Everything below needs an existing fact to act on.
    const target = operation.factRef ? findById(ledger, operation.factRef) : undefined;
    if (!target) {
      applied.push({
        outcome: "rejected",
        factId: null,
        proposedOp: operation.op,
        detail: `no fact with id ${operation.factRef ?? "(none given)"}`,
      });
      continue;
    }

    if (operation.op === "confirm") {
      target.state = "confirmed";
      target.lastTurn = turn;
      if (quote) target.sourceQuote = quote;
      // Restating something raises how sure we are, but only to the top once.
      if (target.confidence === "low") target.confidence = "medium";
      else if (target.confidence === "medium") target.confidence = "high";
      applied.push({ outcome: "confirmed", factId: target.id, proposedOp: "confirm", detail: target.value });
      continue;
    }

    if (operation.op === "refine") {
      mergeInto(target, operation, turn, quote);
      applied.push({ outcome: "refined", factId: target.id, proposedOp: "refine", detail: target.value });
      continue;
    }

    // contradict: the patient corrected themself. Keep the old row for the
    // audit trail, mark it dead, and let the correction land as a new fact.
    target.state = "contradicted";
    target.lastTurn = turn;
    target.contradictionNote = operation.note || quote || "contradicted by a later statement";
    retiredThisTurn.set(identityKey(target.subject, target.attribute), target);
    applied.push({
      outcome: "contradicted",
      factId: target.id,
      proposedOp: "contradict",
      detail: target.contradictionNote,
    });
  }

  return applied;
}

/** Fills in detail the patient has now given, without discarding detail they
 *  gave earlier. A later turn that omits the onset age doesn't erase it. */
function mergeInto(fact: ClinicalFact, operation: ProposedOperation, turn: number, quote: string): void {
  if (operation.value && operation.value.trim()) fact.value = operation.value.trim();
  if (typeof operation.onsetAge === "number") fact.qualifiers.onsetAge = operation.onsetAge;
  if (operation.lastOccurred) fact.qualifiers.lastOccurred = operation.lastOccurred;
  if (operation.status && (FACT_STATUSES as string[]).includes(operation.status)) {
    fact.qualifiers.status = operation.status as FactStatus;
  }
  if (operation.confidence && (CONFIDENCES as string[]).includes(operation.confidence)) {
    fact.confidence = operation.confidence as Confidence;
  }
  if (operation.category) fact.category = resolveCategory(fact.subject, operation.category);
  if (quote) fact.sourceQuote = quote;
  fact.lastTurn = turn;
}

/**
 * Compact view of the ledger handed to the extraction model each turn.
 *
 * This is what makes the pass incremental: the model sees current state plus
 * one new turn, never the whole transcript. Ids are included so it can
 * reference facts precisely instead of restating them.
 */
export function summarizeForPrompt(ledger: LedgerState): string {
  const live = liveFacts(ledger);
  if (live.length === 0) return "(no facts on file yet)";
  return live
    .map((fact) => {
      const bits = [`status=${fact.qualifiers.status}`];
      if (fact.qualifiers.onsetAge != null) bits.push(`onset_age=${fact.qualifiers.onsetAge}`);
      if (fact.qualifiers.lastOccurred) bits.push(`last=${fact.qualifiers.lastOccurred}`);
      return `${fact.id} | ${fact.subject} | ${fact.category} | ${fact.attribute} | ${fact.value} | ${bits.join(", ")}`;
    })
    .join("\n");
}
