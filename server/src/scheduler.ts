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
 *
 * Booking also takes an optional day/time preference (see preference.ts). The
 * patient is asked for one before ACT fires -- see decide.ts's "scheduling"
 * gate -- and this is where it actually gets used to pick a slot rather than
 * always grabbing the earliest one.
 */
import { randomUUID } from "node:crypto";
import type { EscortContact } from "./escort.js";
import { describePreference, type SchedulingPreference, type TimeOfDay } from "./preference.js";

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
  dayOfWeek: number;
  timeOfDay: TimeOfDay;
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
  | { status: "booked"; booking: Booking; matchedPreference: boolean }
  | { status: "waitlisted"; waitlistId: string; reason: string; earliestAvailableDays: number; nextStep: string };

export interface EscortInvite {
  sent: boolean;
  /** Whatever the patient said, verbatim. There's no real contact book to
   *  resolve a name against, so the mock invite just echoes it back as the
   *  "recipient" it would have gone to. */
  to: string | null;
}

const CLINICS = [
  { name: "Bay Endoscopy Center", offsets: [21, 28, 35] },
  { name: "Mission GI Associates", offsets: [24, 31] },
];

/** One morning and one afternoon opening per day-out, so a time-of-day
 *  preference has something to actually match against. */
const TIMES_OF_DAY: Array<{ timeOfDay: TimeOfDay; hour: number }> = [
  { timeOfDay: "morning", hour: 9 },
  { timeOfDay: "afternoon", hour: 14 },
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
      for (const { timeOfDay, hour } of TIMES_OF_DAY) {
        const startsAt = new Date(now.getTime() + daysOut * 24 * 60 * 60 * 1000);
        startsAt.setHours(hour, 0, 0, 0);
        slots.push({
          id: `slot-${clinic.name.split(" ")[0].toLowerCase()}-${daysOut}-${timeOfDay}`,
          clinic: clinic.name,
          startsAt: startsAt.toISOString(),
          durationMinutes: 60,
          daysOut,
          dayOfWeek: startsAt.getDay(),
          timeOfDay,
        });
      }
    }
  }
  // Sorted by urgency first, then morning before afternoon, so "the soonest
  // opening" and "no preference given" both resolve to the same, predictable
  // slot -- important for the eval suite asserting on a specific booking.
  return slots.sort((a, b) => a.daysOut - b.daysOut || (a.timeOfDay === b.timeOfDay ? 0 : a.timeOfDay === "morning" ? -1 : 1));
}

/**
 * Picks the best-matching slot for a stated preference.
 *
 * Falls back in three steps -- exact day+time, day only, time only -- before
 * giving up and taking the earliest opening. `matched` distinguishes "got
 * exactly what they asked for" from "closest available," which is what lets
 * the booking message be honest about the difference instead of always
 * saying "you're booked for X" as if that was guaranteed.
 */
function pickSlot(slots: Slot[], preference: SchedulingPreference | null): { slot: Slot; matched: boolean } {
  if (!preference || preference.soonest) return { slot: slots[0], matched: true };

  const wantsDay = preference.dayOfWeek != null;
  const wantsTime = preference.timeOfDay != null;
  const matchesDay = (slot: Slot) => !wantsDay || slot.dayOfWeek === preference.dayOfWeek;
  const matchesTime = (slot: Slot) => !wantsTime || slot.timeOfDay === preference.timeOfDay;

  const exact = slots.find((slot) => matchesDay(slot) && matchesTime(slot));
  if (exact) return { slot: exact, matched: true };

  const dayOnly = wantsDay ? slots.find(matchesDay) : undefined;
  if (dayOnly) return { slot: dayOnly, matched: false };

  const timeOnly = wantsTime ? slots.find(matchesTime) : undefined;
  if (timeOnly) return { slot: timeOnly, matched: false };

  return { slot: slots[0], matched: false };
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
export function scheduleScreening(
  withinDays: number,
  preference: SchedulingPreference | null = null,
  now: Date = new Date(),
): SchedulingResult {
  const slots = searchSlots(withinDays, now);

  if (slots.length === 0) {
    // A day/time preference has nothing to filter here -- there is no
    // capacity in the window at all, preferred or otherwise.
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

  const { slot, matched } = pickSlot(slots, preference);
  return { status: "booked", booking: confirmHold(holdSlot(slot).id), matchedPreference: matched };
}

/**
 * Mocked calendar-invite send for the post-procedure pickup contact.
 *
 * Real: nothing. This never touches a calendar or email API -- per the
 * decision to mock this rather than build it, it exists only so the booking
 * confirmation can honestly say whether an invite went out, without ever
 * claiming a delivery this app has no way to guarantee. Only called from
 * ACT, and only when a contact was actually given -- see decide.ts's
 * "escort" gate, which never blocks a booking on this being present.
 */
export function sendEscortInvite(contact: EscortContact | null): EscortInvite {
  if (!contact || !contact.provided) return { sent: false, to: null };
  return { sent: true, to: contact.label };
}

export { FIRST_AVAILABLE_DAYS };
