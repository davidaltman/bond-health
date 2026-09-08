#!/usr/bin/env node
/**
 * Deterministic unit check for decide.ts's already_resolved closing/details
 * branches.
 *
 * Deliberately separate from replay_session.mjs: that harness drives a live
 * model call, which is the right place to pin phrasing the regex misses.
 * This file pins the contract that must not depend on a model at all:
 * decide() is a pure function of already-resolved data. closingIntent null
 * falls back to CLOSING_PATTERN / BOOKING_DETAIL_PATTERN; a present
 * judgment wins over the regex, including when the regex would have fired.
 * No server, no model call. If this is flaky, that's a new bug.
 */
import { decide } from "../server/src/decide.js";

const BOOKING = {
  confirmationId: "BH-TEST",
  clinic: "Bay Endoscopy Center",
  when: "Friday, September 25 at 9:00 AM",
};

const CLOSING_SAY =
  "Sounds good — take care, and don't hesitate to reach out if anything comes up before your appointment.";
const DETAILS_SAY =
  "You're booked at Bay Endoscopy Center on Friday, September 25 at 9:00 AM. Your confirmation number is BH-TEST. Anything else I can help with?";
const GENERIC_SAY = "You're all set for the colonoscopy. Anything else I can help with?";

function input(overrides) {
  return {
    turn: 10,
    patientAge: 53,
    facts: [],
    signals: null,
    alreadyResolved: true,
    askCounts: {},
    bookingRequested: true,
    schedulingPreference: { raw: "anytime", dayOfWeek: null, timeOfDay: null, soonest: true },
    escortContact: { provided: false, raw: "", phone: null, email: null, label: "" },
    shippingAddress: { provided: false, raw: "" },
    patientTurn: "",
    closingIntent: null,
    booking: BOOKING,
    waitlist: null,
    mode: "scheduling_only",
    ...overrides,
  };
}

const cases = [
  {
    name: "null closingIntent + regex farewell falls back to closing",
    overrides: { closingIntent: null, patientTurn: "no, that's it" },
    expectSay: CLOSING_SAY,
  },
  {
    name: "null closingIntent + regex date question falls back to details",
    overrides: { closingIntent: null, patientTurn: "what day was that again?" },
    expectSay: DETAILS_SAY,
  },
  {
    name: "closingIntent closing catches a phrase the regex misses",
    overrides: { closingIntent: "closing", patientTurn: "I think that covers it" },
    expectSay: CLOSING_SAY,
  },
  {
    name: "closingIntent details catches a phrase the regex misses",
    overrides: { closingIntent: "details", patientTurn: "who's it with?" },
    expectSay: DETAILS_SAY,
  },
  {
    name: "closingIntent details catches an indirect prep-recall question the regex misses",
    overrides: { closingIntent: "details", patientTurn: "what am I supposed to do again before it?" },
    expectSay: DETAILS_SAY,
  },
  {
    name: "closingIntent other wins over a regex-matching word used in another sense",
    overrides: { closingIntent: "other", patientTurn: "I'm good at keeping appointments" },
    expectSay: GENERIC_SAY,
  },
];

let failed = 0;
for (const testCase of cases) {
  const decision = decide(input(testCase.overrides));
  const pass =
    decision.outcome === "ASK" &&
    decision.gate === "already_resolved" &&
    decision.say === testCase.expectSay;
  console.log(`${pass ? "PASS" : "FAIL"}  ${testCase.name}`);
  if (!pass) {
    failed++;
    console.log(`      patientTurn:   ${JSON.stringify(testCase.overrides.patientTurn)}`);
    console.log(`      closingIntent: ${JSON.stringify(testCase.overrides.closingIntent)}`);
    console.log(`      expected say:  ${JSON.stringify(testCase.expectSay)}`);
    console.log(`      got:           ${decision.outcome} via ${decision.gate}: ${JSON.stringify(decision.say)}`);
  }
}

console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
