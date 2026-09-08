#!/usr/bin/env node
/**
 * Deterministic unit check for extract-turn.ts's coerceStatus / NEGATION_PATTERN.
 *
 * Deliberately separate from replay_session.mjs: that harness needs a live
 * server and a real model call, which is the right place to pin "a bare
 * 'Nope.' answering the red-flag question advances the gate." This file pins
 * the narrower, purely lexical half of the same bug: an "add" claiming
 * "never" must not be silently downgraded to "unknown" just because the
 * patient's word was "nope" rather than "no".
 *
 * Found live in conv_6201m1xb7n63f4darfd5jw8064e8. See extract-turn.ts's
 * NEGATION_PATTERN comment for why `\bno\b` is not enough, and why the
 * word-boundary on `no` must stay.
 */
import { coerceStatus } from "../server/src/extract-turn.js";

const stayNever = [
  "nope",
  "Nope.",
  "nah",
  "nada",
  "naw",
  "nuh-uh",
  "no",
  "no.",
  "Nope, none of that.",
  "not really",
  "no bleeding",
  "meh no",
];

const downgrade = [
  "known history",
  "nonetheless I want screening",
  "the denominator was high",
  "I've had some bleeding",
  "yeah",
  "",
];

let failed = 0;

for (const quote of stayNever) {
  const got = coerceStatus("add", "never", quote);
  const pass = got === "never";
  console.log(`${pass ? "PASS" : "FAIL"}  add/never stays never for ${JSON.stringify(quote)}`);
  if (!pass) {
    failed++;
    console.log(`      got: ${JSON.stringify(got)}`);
  }
}

for (const quote of downgrade) {
  const got = coerceStatus("add", "never", quote);
  const pass = got === "unknown";
  console.log(`${pass ? "PASS" : "FAIL"}  add/never downgrades to unknown for ${JSON.stringify(quote)}`);
  if (!pass) {
    failed++;
    console.log(`      got: ${JSON.stringify(got)}`);
  }
}

const untouched = [
  { op: "add", status: "active", quote: "nope", expect: "active" },
  { op: "add", status: "resolved", quote: "hello", expect: "resolved" },
  { op: "confirm", status: "never", quote: "hello", expect: "never" },
  { op: "add", status: null, quote: "nope", expect: null },
];

for (const testCase of untouched) {
  const got = coerceStatus(testCase.op, testCase.status, testCase.quote);
  const pass = got === testCase.expect;
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${testCase.op}/${testCase.status} is left alone for ${JSON.stringify(testCase.quote)}`,
  );
  if (!pass) {
    failed++;
    console.log(`      expected: ${JSON.stringify(testCase.expect)}`);
    console.log(`      got:      ${JSON.stringify(got)}`);
  }
}

const total = stayNever.length + downgrade.length + untouched.length;
console.log(`\n${total - failed}/${total} checks passed`);
process.exit(failed > 0 ? 1 : 0);
