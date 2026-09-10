/**
 * Stage 12 tests. Run: npx tsx scripts/test-stage12.ts
 * Covers: story-file parsing, story-mode idea schema + prompt, and (later commits) full-story
 * field, ep1/2 voiceover prompt, out-of-order generation, trailer removal.
 */
import assert from "node:assert";
import fs from "node:fs";
import { parseStoryFile, storyKindFromName, cleanStoryText, STORY_MAX_CHARS } from "../lib/parse-story";
import { ideaSchema } from "../lib/validations";
import { ideaFromStorySystemPrompt, ideaFromStoryUserPrompt, detectLanguage } from "../lib/idea";
import {
  FULL_STORY_START_MARK,
  FULL_STORY_END_MARK,
  countFullStoryEpisodes,
  seasonFullStorySchema,
  seasonStoryReviseSchema,
  seasonFullStorySystemPrompt,
  seasonFullStoryUserPrompt,
  seasonStoryReviseSystemPrompt,
  SEASON_MIN_EPISODES,
  SEASON_MAX_EPISODES,
  episodeScriptSystemPrompt,
  sceneScriptSchema,
  validateEpisodeScript,
  normalizeEpisodeScript,
  MAX_SILENT_SCENES,
  EPISODE_MIN_SCENES,
  type SeasonStructure,
  type EpisodeScript,
} from "../lib/season";
import { buildNarrationAudioPrompt, buildNativeAudioPrompt } from "../lib/voiceover";

let pass = 0;
const ok = (cond: unknown, msg: string) => { assert(cond, msg); console.log("ok:", msg); pass++; };

// --- (A) story-file parsing --------------------------------------------------
ok(storyKindFromName("a.txt") === "txt" && storyKindFromName("a.MD") === "md" && storyKindFromName("a.docx") === "docx" && storyKindFromName("a.pdf") === "pdf", "storyKindFromName maps all 4 extensions");
ok(storyKindFromName("a.exe") === null && storyKindFromName("noext") === null, "storyKindFromName rejects unsupported types");
ok(cleanStoryText("a\r\n\r\n\r\n\r\nb").split("\n\n").length === 2, "cleanStoryText collapses blank lines to paragraph breaks");
ok(cleanStoryText("x".repeat(STORY_MAX_CHARS + 500)).length === STORY_MAX_CHARS, "cleanStoryText caps at STORY_MAX_CHARS");

(async () => {
  // txt / md parse from in-memory buffers
  const txt = await parseStoryFile("s.txt", Buffer.from("The Lighthouse of Cape Vell. A young keeper arrives at a remote northern island.", "utf8"));
  ok(txt.kind === "txt" && /Lighthouse/.test(txt.text), "parseStoryFile: .txt returns text");
  const md = await parseStoryFile("s.md", Buffer.from("# Title\n\nA detective investigates a missing violinist in a foggy coastal town.", "utf8"));
  ok(md.kind === "md" && /detective/.test(md.text), "parseStoryFile: .md returns text");
  // docx/pdf only if fixtures exist (created during dev)
  for (const [f, kind] of [["/tmp/story.docx", "docx"], ["/tmp/story.pdf", "pdf"]] as const) {
    if (fs.existsSync(f)) {
      const r = await parseStoryFile(f, fs.readFileSync(f));
      ok(r.kind === kind && r.text.length > 20, `parseStoryFile: .${kind} returns text`);
    }
  }
  await assert.rejects(() => parseStoryFile("s.rtf", Buffer.from("x")), /Неподдерживаемый формат/, "parseStoryFile rejects unsupported extension");
  await assert.rejects(() => parseStoryFile("s.txt", Buffer.from("short")), /Не удалось извлечь/, "parseStoryFile rejects near-empty content");

  // --- (A) idea schema: story mode ------------------------------------------
  const goodStory = "b".repeat(200);
  ok(ideaSchema.safeParse({ projectId: "c".repeat(25), fromStory: true, story: goodStory }).success, "ideaSchema accepts fromStory + story");
  ok(!ideaSchema.safeParse({ projectId: "c".repeat(25), fromStory: true, story: "x" }).success, "ideaSchema rejects fromStory with too-short story");
  // backward compatible: manual + auto still validate
  ok(ideaSchema.safeParse({ projectId: "c".repeat(25), idea: "A finished idea that is long enough." }).success, "ideaSchema still accepts manual idea (backward compatible)");
  ok(ideaSchema.safeParse({ projectId: "c".repeat(25), auto: true, genres: ["detective"] }).success, "ideaSchema still accepts auto+genres (backward compatible)");

  // --- (A) story-mode prompt: canon fidelity + language ---------------------
  const sp = ideaFromStorySystemPrompt("ru");
  ok(/CANON/.test(sp) && /do NOT change the story's plot/.test(sp), "ideaFromStorySystemPrompt: treats story as canon");
  ok(/Russian/.test(sp) && /8-14/.test(sp), "ideaFromStorySystemPrompt: language + 8-14 locations");
  ok(/CANON/.test(ideaFromStoryUserPrompt("some story text")) && ideaFromStoryUserPrompt("XYZ").includes("XYZ"), "ideaFromStoryUserPrompt embeds the uploaded story");
  ok(detectLanguage("Это русская история про смотрителя маяка на севере") === "ru", "detectLanguage: Russian story detected");

  // --- (B) full-story markers + count ---------------------------------------
  const storySample = [
    "Season overview paragraph about the world and the central conflict.",
    "",
    `${FULL_STORY_START_MARK} ЭПИЗОД 1: Пропажа ${FULL_STORY_START_MARK}`,
    "The lighthouse keeper wakes to find the boat gone. He searches the cold shore.",
    `${FULL_STORY_END_MARK} Конец эпизода 1 ${FULL_STORY_END_MARK}`,
    "",
    `${FULL_STORY_START_MARK} ЭПИЗОД 2: Гость ${FULL_STORY_START_MARK}`,
    "A stranger arrives with news that changes everything.",
    `${FULL_STORY_END_MARK} Конец эпизода 2 ${FULL_STORY_END_MARK}`,
  ].join("\n");
  ok(countFullStoryEpisodes(storySample) === 2, "countFullStoryEpisodes counts episode start markers");
  ok(countFullStoryEpisodes("") === 0 && countFullStoryEpisodes(null) === 0, "countFullStoryEpisodes handles empty/null");
  ok(countFullStoryEpisodes("no markers here at all") === 0, "countFullStoryEpisodes returns 0 when no markers");

  // --- (B) full-story schemas -----------------------------------------------
  ok(seasonFullStorySchema.safeParse({ fullStory: "x".repeat(300) }).success, "seasonFullStorySchema accepts fullStory");
  ok(!seasonFullStorySchema.safeParse({ fullStory: "" }).success, "seasonFullStorySchema rejects empty fullStory");
  const reviseGood = {
    title: "Season", logline: "A long enough season logline for the schema.",
    episodes: Array.from({ length: 4 }, (_, i) => ({ number: i + 1, title: `E${i + 1}`, logline: "A concrete dramatic logline sentence.", locationName: "Loc", locationDesc: "A detailed English visual description of the place.", characters: ["A"], arcRole: i === 0 ? "завязка" : i === 3 ? "финал" : "развитие", cliffhanger: "A tense final beat." })),
    fullStory: "x".repeat(300),
  };
  ok(seasonStoryReviseSchema.safeParse(reviseGood).success, "seasonStoryReviseSchema accepts structure + fullStory");
  ok(!seasonStoryReviseSchema.safeParse({ ...reviseGood, fullStory: "" }).success, "seasonStoryReviseSchema requires fullStory");
  ok(!seasonStoryReviseSchema.safeParse({ ...reviseGood, episodes: reviseGood.episodes.slice(0, 2) }).success === (SEASON_MIN_EPISODES > 2), "seasonStoryReviseSchema enforces min episodes");

  // --- (B) full-story prompts ------------------------------------------------
  const fsSys = seasonFullStorySystemPrompt("ru", 7);
  ok(fsSys.includes(FULL_STORY_START_MARK) && fsSys.includes(FULL_STORY_END_MARK), "seasonFullStorySystemPrompt instructs the ═══/─── markers");
  ok(/7 episodes/.test(fsSys) && /Russian/.test(fsSys), "seasonFullStorySystemPrompt: episode count + language");
  ok(/FIRST time a LOCATION appears/.test(fsSys) && /FIRST time a CHARACTER appears/.test(fsSys), "seasonFullStorySystemPrompt: locations & characters described inside prose");
  ok(/no scene numbers|no shot lists|not a shooting script|STORY, not/i.test(fsSys), "seasonFullStorySystemPrompt: story not shooting script");
  const fsUser = seasonFullStoryUserPrompt({ synopsis: "SYN", structure: { title: "T", logline: "L", episodes: [] } as unknown as SeasonStructure, characters: [], locations: [] });
  ok(fsUser.includes("SYN") && /do not change the episode count/i.test(fsUser), "seasonFullStoryUserPrompt embeds synopsis + keeps count");
  const rvSys = seasonStoryReviseSystemPrompt("en", 8);
  ok(/MINIMAL CHANGE/.test(rvSys) && new RegExp(`${SEASON_MIN_EPISODES}[–-]${SEASON_MAX_EPISODES}`).test(rvSys), "seasonStoryReviseSystemPrompt: minimal change + count range for add/remove");
  ok(/add or remove episodes/i.test(rvSys), "seasonStoryReviseSystemPrompt: author may change episode count via prompt");

  // --- (C) location scale + episode locations --------------------------------
  const { locationScale, desiredExtraFrames, episodeLocations } = await import("../lib/location-scale");
  ok(locationScale({ name: "Ночной город", description: "огни небоскрёбов" }) === "huge", "locationScale: city → huge");
  ok(locationScale({ name: "Морской порт", description: "причалы и краны" }) === "big", "locationScale: harbour → big");
  ok(locationScale({ name: "Тесная кухня", description: "маленькая комната" }) === "small", "locationScale: small room → small");
  // Stage 18: frames scale with location size → small 3 (0 extra), big 6 (3 extra), huge 9 (6 extra).
  ok(desiredExtraFrames({ name: "Лес" }) === 6, "desiredExtraFrames: huge → 6 extra (9 total)");
  ok(desiredExtraFrames({ name: "Склад" }) === 3, "desiredExtraFrames: big → 3 extra (6 total)");
  ok(desiredExtraFrames({ name: "Кабинет" }) === 0, "desiredExtraFrames: small → 0 extra (3 total)");
  const locList = [{ id: "l1", name: "Маяк" }, { id: "l2", name: "Пирс" }, { id: "l3", name: "Чердак" }];
  const epLocs = episodeLocations({ locationId: "l1", locationName: "Маяк", scenes: [{ locationDesc: "разговор на пирсе" }] }, locList);
  ok(epLocs.some((l: any) => l.id === "l1") && epLocs.some((l: any) => l.id === "l2"), "episodeLocations: bound location + scene-mentioned location");
  ok(!epLocs.some((l: any) => l.id === "l3"), "episodeLocations: excludes unrelated locations");

  // --- (D) episode-1/2 off-screen narration voiceover ------------------------
  // Scene schema accepts the new narration fields (all optional; defaults to "dialogue").
  const narrScene = sceneScriptSchema.safeParse({
    number: 1, shotType: "wide establishing", locationDesc: "EXT lighthouse dawn", action: "waves crash on the rocks",
    dialogue: "[NO DIALOGUE]", sceneKind: "narration", voiceover: "For thirty years the light never failed.", voiceoverLocal: "Тридцать лет маяк не гас.",
    videoPrompt: "[SHOT TYPE]: wide sweeping b-roll\n[VISUAL STYLE]: photoreal\n[LIGHTING]: cold dawn\n[BLOCKING]: none\n[GAZE]: none\n[NON-VERBAL]: none\n[ACTION]: gulls wheel over the surf\n[CHARACTER]: distant keeper\n[TRANSITION]: hard cut",
    startState: "Anna stands in the doorway, facing the window, hands empty, wide shot from the corner.", endState: "Anna stands by the window, back to the door, hands on the sill, medium shot from the doorway.",
  });
  ok(narrScene.success, "sceneScriptSchema accepts narration fields (voiceover/voiceoverLocal/sceneKind)");
  ok(sceneScriptSchema.parse({ number: 1, shotType: "med", locationDesc: "room", action: "they talk", dialogue: "A: hi", videoPrompt: "x".repeat(41), startState: "Anna stands in the doorway, facing the window, hands empty, wide shot from the corner.", endState: "Anna stands by the window, back to the door, hands on the sill, medium shot from the doorway." }).sceneKind === "dialogue", "sceneScriptSchema defaults sceneKind to 'dialogue'");

  // Episode-1 system prompt FORCES an opening narration scene (mandatory backstory voiceover).
  const ep1sys = episodeScriptSystemPrompt("ru", 1);
  ok(/MANDATORY/.test(ep1sys) && /EPISODE 1/.test(ep1sys) && /"sceneKind": "narration"/.test(ep1sys), "episodeScriptSystemPrompt(ep1): opening narration MANDATORY");
  ok(/off-screen NARRATOR/i.test(ep1sys) && /no lip-sync/i.test(ep1sys) && /voiceover/.test(ep1sys), "episodeScriptSystemPrompt(ep1): off-screen narrator, no lip-sync b-roll");
  ok(/voiceoverLocal/.test(ep1sys), "episodeScriptSystemPrompt(ep1,ru): asks for translated voiceoverLocal");
  // Episode-2 = OPTIONAL catch-up only (not forced).
  const ep2sys = episodeScriptSystemPrompt("ru", 2);
  ok(/OPTIONAL/.test(ep2sys) && /NOT required/i.test(ep2sys), "episodeScriptSystemPrompt(ep2): catch-up narration OPTIONAL, not forced");
  // Episode-3+ = no narration.
  const ep3sys = episodeScriptSystemPrompt("ru", 3);
  ok(/NO opening narration/.test(ep3sys), "episodeScriptSystemPrompt(ep3): no opening narration");
  // English project: no voiceoverLocal requested.
  ok(!/voiceoverLocal/.test(episodeScriptSystemPrompt("en", 1)), "episodeScriptSystemPrompt(en): no voiceoverLocal for English projects");

  // validateEpisodeScript: a narration scene (dialogue empty but voiceover present) does NOT count as silent.
  const vp = "[SHOT TYPE]: wide\n[VISUAL STYLE]: photoreal\n[LIGHTING]: dawn\n[BLOCKING]: move\n[GAZE]: at each other\n[NON-VERBAL]: gestures\n[ACTION]: they cross the room and background life continues\n[CHARACTER]: Anna 30\n[TRANSITION]: hard cut";
  const talk = (n: number) => ({ number: n, shotType: "medium two-shot", durationSec: 20, locationDesc: "INT room day", characters: ["Anna", "Victor"], action: "they argue and one crosses the room", dialogue: 'ANNA (sharply): "You knew and you said nothing to me all winter." VICTOR (quietly): "I did what kept us both alive that year."', sceneKind: "dialogue" as const, videoPrompt: vp, startState: "Anna stands in the doorway, facing the window, hands empty, wide shot from the corner.", endState: "Anna stands by the window, back to the door, hands on the sill, medium shot from the doorway." });
  const narr = { number: 1, shotType: "wide b-roll", durationSec: 18, locationDesc: "EXT dawn", characters: [], action: "waves crash and gulls wheel over the surf", dialogue: "[NO DIALOGUE]", sceneKind: "narration" as const, voiceover: "For thirty years the light never failed, until the night it did.", voiceoverLocal: "Тридцать лет маяк не гас.", videoPrompt: vp, startState: "Anna stands in the doorway, facing the window, hands empty, wide shot from the corner.", endState: "Anna stands by the window, back to the door, hands on the sill, medium shot from the doorway." };
  const withNarr: EpisodeScript = normalizeEpisodeScript({ visualIdentity: "photoreal coastal drama", scenes: [narr, ...Array.from({ length: EPISODE_MIN_SCENES }, (_, i) => talk(i + 2))] } as EpisodeScript);
  const problemsN = validateEpisodeScript(withNarr);
  ok(!problemsN.some((p) => /too many silent/.test(p)), "validateEpisodeScript: narration scene NOT counted against silent budget");
  ok(withNarr.scenes[0].sceneKind === "narration" && !!withNarr.scenes[0].voiceover, "normalizeEpisodeScript: keeps narration sceneKind + voiceover");
  ok(withNarr.scenes[1].sceneKind === "dialogue" && !withNarr.scenes[1].voiceover, "normalizeEpisodeScript: normal scene has no voiceover, kind dialogue");

  // A truly silent (no dialogue, no voiceover) scene still counts toward the silent budget.
  const trulySilent = { ...talk(2), dialogue: "[NO DIALOGUE]", sceneKind: "dialogue" as const };
  const manySilent: EpisodeScript = normalizeEpisodeScript({ visualIdentity: "photoreal", scenes: [trulySilent, { ...trulySilent, number: 3 }, { ...trulySilent, number: 4 }, talk(5), talk(6), talk(7)] } as EpisodeScript);
  ok(validateEpisodeScript(manySilent).some((p) => /too many silent/.test(p)), `validateEpisodeScript: >${MAX_SILENT_SCENES} truly-silent scenes still flagged`);

  // buildNarrationAudioPrompt: English off-screen narrator, verbatim, no music/subtitles/lip-sync.
  const np = buildNarrationAudioPrompt("[SHOT TYPE]: wide b-roll", "For thirty years the light never failed.");
  ok(/off-screen narrator/i.test(np) && /English/.test(np), "buildNarrationAudioPrompt: off-screen English narrator");
  ok(np.includes("For thirty years the light never failed."), "buildNarrationAudioPrompt: reads narration verbatim");
  ok(/NO background music/i.test(np) && /no.*subtitles/i.test(np) && /no lip-sync/i.test(np), "buildNarrationAudioPrompt: no music, no subtitles, no lip-sync");
  ok(/NO on-camera dialogue/i.test(np), "buildNarrationAudioPrompt: no on-camera dialogue");
  // Normal dialogue prompt still lip-syncs on camera (not broken by Commit D).
  const dp = buildNativeAudioPrompt("[SHOT TYPE]: medium", 'ANNA (softly): "We should go."', [{ name: "Anna" }], "English");
  ok(/ on camera: "We should go\."/i.test(dp) && /whenever the speaker's mouth IS visible/i.test(dp), "buildNativeAudioPrompt: normal scenes still speak on camera; face in frame is a staging choice (Stage 38)");

  console.log(`\nALL STAGE12 CHECKS PASSED (${pass})`);
})();
