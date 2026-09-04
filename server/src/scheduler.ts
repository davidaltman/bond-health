/**
 * Mock scheduling. Real shape, fake backend.
 *
 * Mocked: the clinic directory, the slot inventory, insurance eligibility.
 * Real: the search -> hold -> confirm sequence, the failure path, and the
 * confirmation artifact the decision engine hands back as proof it acted.
 *
 * The sequence is three steps rather than one `book()` because the interesting
 * failure is between them -- a slot that was free at search time can be gone by
 * confirm time, and an agent that models booking as a single atomic call has no
 * way to represent that. Holds here expire, so that case is reachable.
 *
 * The unhappy path is not a random failure injection. The mock clinic simply
 * has no colonoscopy capacity inside 21 days, so any patient whose guideline
 * window is tighter than that (elevated risk, never screened) falls through to
 * the waitlist. That means the failure is a property of the scenario rather
 * than of a coin flip, and the eval suite can assert on it.
 */
import { randomUUID } from "node:crypto";

/** Colonoscopy needs prep, a driver, and a scoped room. Nothing inside three
 *  weeks in this mock clinic, which is realistic and makes the tight-window
 *  path reachable. */
const FIRST_AVAILABLE_DAYS = 21;
const HOLD_TTL_MS = 10 * 60 * 1000;

export interface Slot {
  id: string;
  clinic: string;
  startsAt: string;
  durationMinutes: number;
  daysOut: number;
}

export interface Hold {
  id: string;
  slot: Slot;
  expiresAt: number;
}

export interface Booking {
  confirmationId: string;
  slot: Slot;
  prepInstructions: string[];
  bookedAt: string;
}

export type SchedulingResult =
  | { status: "booked"; booking: Booking }
  | { status: "waitlisted"; waitlistId: string; reason: string; earliestAvailableDays: number; nextStep: string };

const CLINICS = [
  { name: "Bay Endoscopy Center", offsets: [21, 28, 35] },
  { name: "Mission GI Associates", offsets: [24, 31] },
];

const holds = new Map<string, Hold>();

/**
 * Slots inside `withinDays`. Deterministic given a reference date, so evals
 * that assert on a booking don't fail because a day rolled over.
 */
export function searchSlots(withinDays: number, now: Date = new Date()): Slot[] {
  const slots: Slot[] = [];
  for (const clinic of CLINICS) {
    for (const daysOut of clinic.offsets) {
      if (daysOut > withinDays) continue;
      const startsAt = new Date(now.getTime() + daysOut * 24 * 60 * 60 * 1000);
      startsAt.setHours(9, 0, 0, 0);
      slots.push({
        id: `slot-${clinic.name.split(" ")[0].toLowerCase()}-${daysOut}`,
        clinic: clinic.name,
        startsAt: startsAt.toISOString(),
        durationMinutes: 60,
        daysOut,
      });
    }
  }
  return slots.sort((a, b) => a.daysOut - b.daysOut);
}

export function holdSlot(slot: Slot): Hold {
  const hold: Hold = { id: `hold-${randomUUID().slice(0, 8)}`, slot, expiresAt: Date.now() + HOLD_TTL_MS };
  holds.set(hold.id, hold);
  return hold;
}

export function confirmHold(holdId: string): Booking {
  const hold = holds.get(holdId);
  if (!hold) throw new Error(`No hold ${holdId}`);
  if (hold.expiresAt < Date.now()) {
    holds.delete(holdId);
    throw new Error(`Hold ${holdId} expired before confirmation`);
  }
  holds.delete(holdId);
  return {
    confirmationId: `BH-${randomUUID().slice(0, 8).toUpperCase()}`,
    slot: hold.slot,
    prepInstructions: PREP_INSTRUCTIONS,
    bookedAt: new Date().toISOString(),
  };
}

/** Authored copy, not generated. Same discipline as the guideline table. */
const PREP_INSTRUCTIONS = [
  "Clear liquids only for the full day before your appointment.",
  "Your prep kit arrives by mail about a week ahead, with a start time on the label.",
  "Arrange a ride home — sedation means you can't drive yourself.",
  "Keep taking your regular medications unless your care team tells you otherwise.",
];

/**
 * The full sequence, returning either a confirmation or an honest failure.
 *
 * A resolution layer with only a happy path proves nothing, so the waitlist
 * branch returns a concrete next step rather than an apology.
 */
export function scheduleScreening(withinDays: number, now: Date = new Date()): SchedulingResult {
  const slots = searchSlots(withinDays, now);

  if (slots.length === 0) {
    const earliest = Math.min(...CLINICS.flatMap((clinic) => clinic.offsets));
    return {
      status: "waitlisted",
      waitlistId: `WL-${randomUUID().slice(0, 8).toUpperCase()}`,
      reason: `No colonoscopy capacity within the ${withinDays}-day window your risk level calls for; earliest routine opening is ${earliest} days out.`,
      earliestAvailableDays: earliest,
      nextStep:
        `You're on the cancellation list, which usually moves within a week or two. I've also flagged ` +
        `this for your care team to review, since your history means it shouldn't wait longer than it has to.`,
    };
  }

  return { status: "booked", booking: confirmHold(holdSlot(slots[0]).id) };
}

export { FIRST_AVAILABLE_DAYS };
