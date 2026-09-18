/**
 * Stage 8 (final) — project-level dialogueLanguage plumbing (DEFAULT English).
 *
 * The scenario core produces ENGLISH dialogue by default; a project may OPT IN to another language later
 * without changing any current behavior. This suite unit-tests, offline, every pure piece:
 *   - normalizeDialogueLanguage (codes, region tags, labels, garbage → "en");
 *   - getDialogueLanguage resolver (null / missing / old rows → "en");
 *   - the v6.8.0 directive is a genuine NO-OP for English (""), non-empty for others;
 *   - the shot LINE block: English path is unchanged (line verbatim), non-English path references the
 *     ENGLISH lineTranslation for the model while the stored line stays in the dialogue language;
 *   - burned subtitles carry the dialogue language and default to "en";
 *   - the episode-script prompt injects the directive only for non-English (default byte-identical).
 *
 * Pure/synthetic only — NO network, NO LLM, NO DB, NO paid generations.
 * Run: timeout 180 npx tsx --tsconfig tsconfig.json scripts/test-stage173.ts
 */
import {
  DIALOGUE_LANGUAGE_PROMPT_VERSION,
  DEFAULT_DIALOGUE_LANGUAGE,
  normalizeDialogueLanguage,
  getDialogueLanguage,
  isEnglish,
  dialogueLanguageLabel,
  dialogueLanguageDirective,
} from "../lib/dialogue-language";
import { shotLineBlock } from "../lib/prompts/shot";
import { buildSubtitleSpec } from "../lib/shot-pipeline";
import { episodeScriptUserPrompt } from "../lib/season";

let passed = 0;
function ok(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exit(1);
  }
  passed++;
  console.log("ok: " + msg);
}

/* ────────────────────────── 1) normalizer + resolver ────────────────────────── */

ok(DIALOGUE_LANGUAGE_PROMPT_VERSION === "6.8.0", "dialogue-language prompt version is 6.8.0");
ok(DEFAULT_DIALOGUE_LANGUAGE === "en", "default dialogue language is en");
ok(normalizeDialogueLanguage("uk") === "uk", "normalize keeps a supported bare code");
ok(normalizeDialogueLanguage("UK") === "uk", "normalize is case-insensitive");
ok(normalizeDialogueLanguage("uk-UA") === "uk", "normalize strips a region tag");
ok(normalizeDialogueLanguage("en_US") === "en", "normalize strips an underscore region tag");
ok(normalizeDialogueLanguage("Ukrainian") === "uk", "normalize accepts a full English label");
ok(normalizeDialogueLanguage("klingon") === "en", "normalize falls back to en for an unsupported language");
ok(normalizeDialogueLanguage("") === "en", "normalize falls back to en for empty string");
ok(normalizeDialogueLanguage(null) === "en" && normalizeDialogueLanguage(undefined) === "en", "normalize falls back to en for null/undefined");
ok(normalizeDialogueLanguage(42) === "en", "normalize falls back to en for a non-string");

/* resolver: old rows / nulls → en (DEFAULT behavior preserved) */
ok(getDialogueLanguage(null) === "en", "resolver: null project → en");
ok(getDialogueLanguage({}) === "en", "resolver: project with no field → en");
ok(getDialogueLanguage({ dialogueLanguage: null }) === "en", "resolver: legacy null field → en (old projects unchanged)");
ok(getDialogueLanguage({ dialogueLanguage: "es" }) === "es", "resolver: explicit code passes through");
ok(getDialogueLanguage({ dialogueLanguage: "Spanish" }) === "es", "resolver: explicit label normalizes");

ok(isEnglish("en") && isEnglish(null) && isEnglish("English"), "isEnglish true for en/null/English");
ok(!isEnglish("uk"), "isEnglish false for a non-English code");
ok(dialogueLanguageLabel("uk") === "Ukrainian" && dialogueLanguageLabel(null) === "English", "label resolves + defaults");

/* ────────────────────────── 2) directive is a no-op for English ────────────────────────── */

ok(dialogueLanguageDirective("en") === "", "directive is EMPTY for en (genuine no-op)");
ok(dialogueLanguageDirective(null) === "" && dialogueLanguageDirective(undefined) === "", "directive empty for null/undefined (default)");
ok(dialogueLanguageDirective("English") === "", "directive empty for the English label");
{
  const uk = dialogueLanguageDirective("uk");
  ok(uk.length > 0 && uk.includes("Ukrainian"), "directive names the language for a non-English project");
  ok(/dialogue/i.test(uk) && /names/i.test(uk) && /title/i.test(uk), "directive covers dialogue, names and titles");
}

/* ────────────────────────── 3) shot LINE block: en unchanged, non-en uses lineTranslation ────────────────────────── */

function shotInput(over: Record<string, unknown>) {
  return {
    characters: [],
    shot: {
      index: 0,
      sceneNumber: 1,
      shotType: "dialogue" as const,
      size: "MCU" as const,
      duration: 3,
      camera: "ots-medium",
      escalationBeat: "verbal",
      postFx: "none" as const,
      matchCutIn: "",
      matchCutOut: "",
      line: "You lied to me.",
    },
    ...over,
  };
}

{
  // English (default): the line IS English, verbatim, NO translation branch.
  const en = shotLineBlock(shotInput({ dialogueLanguage: "en" }) as never);
  ok(en.includes("You lied to me.") && /spoken in English/i.test(en), "en LINE block: line verbatim, spoken in English");
  ok(!/translation/i.test(en), "en LINE block has NO translation branch (identical to current behavior)");
  const enDefault = shotLineBlock(shotInput({}) as never);
  ok(enDefault === en, "en LINE block is the same whether dialogueLanguage is 'en' or absent (default)");
}
{
  // Non-English: burned subtitle + stored line stay in the dialogue language, but the model reads English.
  const shot = { ...shotInput({}).shot, line: "Ти мені збрехав." };
  const uk = shotLineBlock({ characters: [], shot, dialogueLanguage: "uk", lineTranslation: "You lied to me." } as never);
  ok(/spoken in Ukrainian/i.test(uk), "non-en LINE block declares the spoken language");
  ok(uk.includes("You lied to me."), "non-en LINE block feeds the ENGLISH translation to the model");
  ok(!uk.includes("Ти мені збрехав."), "non-en LINE block does NOT feed the native line to the video model");
  // fallback: no translation → the native line is used (never empty)
  const noTrans = shotLineBlock({ characters: [], shot, dialogueLanguage: "uk" } as never);
  ok(noTrans.includes("Ти мені збрехав."), "non-en LINE block falls back to the native line when no translation supplied");
}
{
  // a silent shot yields no LINE block in either language
  const shot = { ...shotInput({}).shot, line: "" };
  ok(shotLineBlock({ characters: [], shot, dialogueLanguage: "uk", lineTranslation: "x" } as never) === "", "silent shot → no LINE block");
}

/* ────────────────────────── 4) subtitles carry the dialogue language ────────────────────────── */

{
  const shots = [
    { index: 0, duration: 3, line: "Hello there." },
    { index: 1, duration: 2, line: "" },
  ];
  ok(buildSubtitleSpec(shots).language === "en", "subtitles default to en");
  ok(buildSubtitleSpec(shots, { dialogueLanguage: "uk" }).language === "uk", "subtitles carry the project dialogue language");
  ok(buildSubtitleSpec(shots).alignment === "center", "subtitles stay centered (unchanged burning behavior)");
  ok(buildSubtitleSpec(shots).cues.length === 1, "one cue per spoken line; silent shot has none");
}

/* ────────────────────────── 5) episode-script prompt: default no-op, non-en injects directive ────────────────────────── */

const baseEpInput = {
  synopsis: "A courtroom drama.",
  season: { title: "S1", logline: "the trial" } as never,
  episode: { number: 1, title: "Pilot", arcRole: "setup", logline: "it begins", description: "", cliffhanger: "a knock", locationName: "Court", locationDesc: "INT. court — day", characters: [] } as never,
  characters: [] as never,
  previous: [] as never,
};

{
  const en = episodeScriptUserPrompt({ ...baseEpInput, dialogueLanguage: "en" });
  const enAbsent = episodeScriptUserPrompt({ ...baseEpInput });
  ok(en === enAbsent, "episode-script prompt is identical for dialogueLanguage 'en' vs absent (default behavior preserved)");
  ok(!/DIALOGUE LANGUAGE:/.test(en), "episode-script prompt has NO language directive for English");
  const uk = episodeScriptUserPrompt({ ...baseEpInput, dialogueLanguage: "uk" });
  ok(/DIALOGUE LANGUAGE:/.test(uk) && uk.includes("Ukrainian"), "episode-script prompt injects the directive for a non-English project");
}


console.log(`\nStage 173: PASS (${passed} checks)`);
