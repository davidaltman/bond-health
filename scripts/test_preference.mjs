#!/usr/bin/env node
/**
 * Deterministic unit check for preference.ts.
 *
 * Deliberately separate from replay_session.mjs: that harness drives the live
 * server and its scheduling assertions inherit the real calendar date, which
 * is exactly wrong for pinning down a parsing bug. Whether "Wednesday
 * afternoon" happens to fall inside the mock clinic's slot window depends on
 * what day it is when the suite runs (see docs/app-guide.md's limitations
 * section) -- but parseSchedulingPreference itself takes no date input at
 * all, so its behavior should never depend on when this runs. No server, no
 * model call, no clock. If this is flaky, that's a new bug.
 *
 * This exists specifically because of a regression: a reply combining a
 * stated day/time with an affirmation phrase ("Wednesday afternoon works for
 * me") was silently read as "no preference, take the soonest," discarding
 * the day/time the patient had just given. See preference.ts's
 * AMBIGUOUS_SOONEST_PATTERN comment for the fix.
 *
 * Two more regressions live here now, both found from the same live
 * transcript: "fridays after noon are best" parsed as no signal at all
 * (null) three turns in a row, because the day-of-week regex required the
 * exact singular "friday" (missing the plural "fridays"), and the
 * time-of-day regex required the one-word "afternoon" (missing the very
 * common two-word "after noon"). See preference.ts's dayOfWeek/timeOfDay
 * comments for the fix.
 */
import { parseSchedulingPreference, describePreference } from "../server/src/preference.js";

const cases = [
  {
    name: "day/time paired with an affirmation phrase must not become soonest",
    input: "Wednesday afternoon works for me.",
    expect: { dayOfWeek: 3, timeOfDay: "afternoon", soonest: false },
  },
  {
    name: "affirmation phrase alone (no day/time) means soonest",
    input: "whatever works for me",
    expect: { dayOfWeek: null, timeOfDay: null, soonest: true },
  },
  {
    name: "unambiguous soonest language always wins, even oddly phrased",
    input: "as soon as you possibly can",
    expect: { dayOfWeek: null, timeOfDay: null, soonest: true },
  },
  {
    name: "day/time paired with a different affirmation phrase (up to you)",
    input: "Tuesday morning, up to you though",
    expect: { dayOfWeek: 2, timeOfDay: "morning", soonest: false },
  },
  {
    name: "day alone, no time, no affirmation",
    input: "Could we do Friday?",
    expect: { dayOfWeek: 5, timeOfDay: null, soonest: false },
  },
  {
    name: "time alone, no day",
    input: "Mornings are easiest for me.",
    expect: { dayOfWeek: null, timeOfDay: "morning", soonest: false },
  },
  {
    name: "no scheduling signal at all returns null, not a guess",
    input: "I'm still not sure I want to do this.",
    expect: null,
  },
  {
    name: "plural day name (fridays) matches the same as the singular",
    input: "Fridays are usually good for me.",
    expect: { dayOfWeek: 5, timeOfDay: null, soonest: false },
  },
  {
    name: "'after noon' as two words means afternoon, not just the one-word form",
    input: "I'd prefer after noon if that's possible",
    expect: { dayOfWeek: null, timeOfDay: "afternoon", soonest: false },
  },
  {
    name: "regression: plural day + two-word 'after noon' together, exact live transcript wording",
    input: "fridays after noon are best",
    expect: { dayOfWeek: 5, timeOfDay: "afternoon", soonest: false },
  },
];

let failed = 0;
for (const testCase of cases) {
  const got = parseSchedulingPreference(testCase.input);
  const pass =
    testCase.expect === null
      ? got === null
      : got !== null &&
        got.dayOfWeek === testCase.expect.dayOfWeek &&
        got.timeOfDay === testCase.expect.timeOfDay &&
        got.soonest === testCase.expect.soonest;

  console.log(`${pass ? "PASS" : "FAIL"}  ${testCase.name}`);
  if (!pass) {
    failed++;
    console.log(`      input:    ${JSON.stringify(testCase.input)}`);
    console.log(`      expected: ${JSON.stringify(testCase.expect)}`);
    console.log(`      got:      ${JSON.stringify(got)}`);
  }
}

// describePreference is patient-facing copy, not decision logic, but a crash
// here would surface as a broken booking confirmation, so it's worth the one
// extra check.
try {
  const described = describePreference({ raw: "", dayOfWeek: 3, timeOfDay: "afternoon", soonest: false });
  const pass = described === "Wednesday afternoon";
  console.log(`${pass ? "PASS" : "FAIL"}  describePreference formats day + time for patient-facing copy`);
  if (!pass) {
    failed++;
    console.log(`      got: ${JSON.stringify(described)}`);
  }
} catch (error) {
  failed++;
  console.log(`FAIL  describePreference threw: ${error instanceof Error ? error.message : String(error)}`);
}

console.log(`\n${cases.length + 1 - failed}/${cases.length + 1} checks passed`);
process.exit(failed > 0 ? 1 : 0);
