#!/usr/bin/env node
/**
 * Deterministic unit check for requirements.ts red-flag slot matching.
 *
 * Live symptom: answering the authored red-flag question with the same word
 * it used ("Yeah, I've had bleeding.") never filled rectal_bleeding, so
 * decide() kept re-asking. The first fix was one more regex phrase
 * (`\bbleed`) -- which only patched that exact transcript. "Spotting",
 * "streaks", "dark stools", "blood when I wipe" would all have missed it
 * too, and there is no finite phrase list that covers every way a patient
 * describes a red flag. The real fix: extractTurn's system prompt now
 * instructs the model to canonicalize any of the four red-flag symptoms to
 * one exact attribute key, and slotsForFact matches that key exactly first,
 * falling back to the old regexes only as a safety net. This file can only
 * exercise the exact-match path and the fallback net deterministically --
 * it cannot exercise the model's canonicalization itself (see
 * harness_inputs/red_flag_bleeding_colloquial.json for that, against a live
 * model). No server, no model here. If this is flaky, that's a new bug.
 */
import { slotsForFact } from "../server/src/requirements.js";

function fact(attribute, value, subject = "self") {
  return { subject, attribute, value };
}

const cases = [
  // --- Primary path: exact match on the canonical key extractTurn is
  // instructed to produce. This is what actually carries open-ended
  // phrasing now -- the model, not a regex, decides "spotting" means
  // rectal_bleeding, and just hands back the exact key.
  {
    name: "canonical attribute rectal_bleeding matches exactly",
    input: fact("rectal_bleeding", "some spotting now and then"),
    expect: ["rectal_bleeding"],
  },
  {
    name: "canonical attribute unexplained_weight_loss matches exactly",
    input: fact("unexplained_weight_loss", "clothes fitting looser lately"),
    expect: ["unexplained_weight_loss"],
  },
  {
    name: "canonical attribute bowel_habit_change matches exactly",
    input: fact("bowel_habit_change", "alternating between constipation and diarrhea"),
    expect: ["bowel_habit_change"],
  },
  {
    name: "canonical attribute iron_deficiency_anemia matches exactly",
    input: fact("iron_deficiency_anemia", "found out I'm low on iron"),
    expect: ["iron_deficiency_anemia"],
  },
  {
    name: "canonical match only applies to subject self, not a relative",
    input: fact("rectal_bleeding", "spotting", "mother"),
    expect: [],
  },

  // --- Fallback net: covers the rare turn the model didn't canonicalize.
  // Intentionally narrow -- proving the net still catches the phrasings it
  // always caught, not that it catches everything (that's the point).
  {
    name: "fallback: bare 'bleeding' attribute still fills rectal_bleeding",
    input: fact("bleeding", "Yeah, I've had bleeding."),
    expect: ["rectal_bleeding"],
  },
  {
    name: "fallback: blood in stool (existing harness wording) still fills the slot",
    input: fact("rectal bleeding", "blood in my stool the last few weeks"),
    expect: ["rectal_bleeding"],
  },
  {
    name: "fallback net does NOT catch 'spotting' -- this is exactly why canonicalization exists",
    input: fact("spotting", "some spotting now and then"),
    expect: [],
  },

  // --- Non-red-flag guardrails, unchanged.
  {
    name: "blood pressure must not be treated as a GI red flag",
    input: fact("blood pressure", "my blood pressure is high"),
    expect: [],
  },
  {
    name: "nosebleed must not fill rectal_bleeding via a substring 'bleed'",
    input: fact("nosebleed", "occasional nosebleed"),
    expect: [],
  },
];

let failed = 0;
for (const testCase of cases) {
  const got = slotsForFact(testCase.input);
  const pass = JSON.stringify(got) === JSON.stringify(testCase.expect);
  console.log(`${pass ? "PASS" : "FAIL"}  ${testCase.name}`);
  if (!pass) {
    failed++;
    console.log(`      input:    ${JSON.stringify(testCase.input)}`);
    console.log(`      expected: ${JSON.stringify(testCase.expect)}`);
    console.log(`      got:      ${JSON.stringify(got)}`);
  }
}

console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
