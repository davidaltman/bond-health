#!/usr/bin/env node
/**
 * Deterministic unit check for shipping.ts's deriveShippingLine.
 *
 * Deliberately separate from replay_session.mjs: that harness drives the live
 * server and a real model call, which is the right place to pin "the spoken
 * booking confirmation does not contain 'ships to Send it to'". This file
 * pins the narrower, purely lexical half of the same bug: a command phrase
 * in front of an address must not become the display line interpolated into
 * "Your prep kit ships to {address}". No server, no model call, no clock.
 *
 * Found live in conv_6201m1xb7n63f4darfd5jw8064e8. See shipping.ts's
 * LEADING_COMMAND_PATTERN comment for why this stays regex rather than an
 * LLM strip, and why the filler words are word-bounded.
 */
import { deriveShippingLine, parseShippingAddress } from "../server/src/shipping.js";
import { scheduleDrinkPrepShipment } from "../server/src/scheduler.js";

const APPOINTMENT = "2026-09-28T16:00:00.000Z";

const displayCases = [
  {
    name: "regression: exact live-transcript phrasing, command phrase stripped",
    input: "Send it to 124 Happy Lane, London, England.",
    expect: "124 Happy Lane, London, England",
  },
  {
    name: "ship it to",
    input: "Ship it to 42 Wallaby Way",
    expect: "42 Wallaby Way",
  },
  {
    name: "you can mail it to",
    input: "You can mail it to 500 Elm Street, Apt 3",
    expect: "500 Elm Street, Apt 3",
  },
  {
    name: "please send it to, remainder kept (including 'my home address')",
    input: "Please send it to my home address, 10 Downing Street",
    expect: "my home address, 10 Downing Street",
  },
  {
    name: "plain address with no lead-in is unchanged",
    input: "124 Happy Lane, London, England",
    expect: "124 Happy Lane, London, England",
  },
  {
    name: "plain address still loses trailing sentence punctuation",
    input: "789 Birch Lane, Riverside.",
    expect: "789 Birch Lane, Riverside",
  },
  {
    name: "backchannel plus command phrase",
    input: "Yeah, send it to 124 Happy Lane",
    expect: "124 Happy Lane",
  },
  {
    name: "address is",
    input: "address is 10 Downing Street",
    expect: "10 Downing Street",
  },
  {
    name: "it's",
    input: "It's 789 Birch Lane, Riverside.",
    expect: "789 Birch Lane, Riverside",
  },
  {
    name: "must not eat a real street that starts with 'South'",
    input: "South Main Street",
    expect: "South Main Street",
  },
  {
    name: "must not eat a real city that starts with 'Ok'",
    input: "Oklahoma City",
    expect: "Oklahoma City",
  },
  {
    name: "must not eat a real street that starts with 'Well'",
    input: "Wellington Road",
    expect: "Wellington Road",
  },
];

let failed = 0;

for (const testCase of displayCases) {
  const got = deriveShippingLine(testCase.input);
  const pass = got === testCase.expect;
  console.log(`${pass ? "PASS" : "FAIL"}  ${testCase.name}`);
  if (!pass) {
    failed++;
    console.log(`      input:    ${JSON.stringify(testCase.input)}`);
    console.log(`      expected: ${JSON.stringify(testCase.expect)}`);
    console.log(`      got:      ${JSON.stringify(got)}`);
  }
}

{
  const raw = "Send it to 124 Happy Lane, London, England.";
  const parsed = parseShippingAddress(raw);
  const shipment = scheduleDrinkPrepShipment(parsed, APPOINTMENT);
  const pass =
    parsed.provided === true &&
    parsed.raw === raw &&
    shipment.ordered === true &&
    shipment.address === "124 Happy Lane, London, England";
  console.log(`${pass ? "PASS" : "FAIL"}  parser keeps raw; shipment.address is the stripped display line`);
  if (!pass) {
    failed++;
    console.log(`      parsed:   ${JSON.stringify(parsed)}`);
    console.log(`      shipment: ${JSON.stringify({ ordered: shipment.ordered, address: shipment.address })}`);
  }
}

{
  const parsed = parseShippingAddress("I'll just grab one at the pharmacy");
  const shipment = scheduleDrinkPrepShipment(parsed, APPOINTMENT);
  const pass = parsed.provided === false && shipment.ordered === false && shipment.address === null;
  console.log(`${pass ? "PASS" : "FAIL"}  a pharmacy decline still produces provided: false, no shipment`);
  if (!pass) {
    failed++;
    console.log(`      parsed:   ${JSON.stringify(parsed)}`);
    console.log(`      shipment: ${JSON.stringify({ ordered: shipment.ordered, address: shipment.address })}`);
  }
}

const total = displayCases.length + 2;
console.log(`\n${total - failed}/${total} checks passed`);
process.exit(failed > 0 ? 1 : 0);
