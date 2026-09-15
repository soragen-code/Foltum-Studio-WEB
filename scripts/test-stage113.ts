/**
 * Stage 113 — location set inventory written at the idea stage; detailed wide/layout references; script + video prompt use it.
 * Run: timeout 90 npx tsx --tsconfig tsconfig.json scripts/test-stage113.ts
 */
import assert from 'node:assert/strict';
import { locationCardSchema, parseSetInventory, serializeSetInventory, hasFullSetInventory, MIN_SET_INVENTORY, setInventoryRetryNote, sanitizeLocationCard, LOCATION_FIELD_RULES_TEXT_FOR_TESTS } from '../lib/idea';
import { locationAnglePrompt, formatSetInventoryBlock, setInventoryEntries, MAX_INVENTORY_IN_PROMPT, VISUAL_STYLE_ID } from '../lib/visual-style';
import { episodeScriptUserPrompt, episodeScriptSystemPrompt, locationInventoryBlock, checkSceneSetInventory, renderEpisodeScriptText, sceneScriptSchema } from '../lib/season';
import { buildScenePrompt, matchSetInventoryInText, buildSetObjectsSection, SET_OBJECTS_CAP, SCENE_SECTION } from '../lib/scene-prompt';

let checks = 0;
const ok = (c: unknown, message: string) => { assert(c, message); checks++; };

const inventory = [
  'steel desk — center-left, facing the window wall',
  'cracked leather armchair — right of the desk',
  'wall of filing cabinets — back wall',
  'tall window with broken blinds — left wall',
  'brass floor lamp — behind the armchair',
  'metal door with frosted glass — far right, entrance',
  'rotary telephone — on the desk, left corner',
  'wooden coat rack — beside the door',
  'small safe — under the desk, right',
  'ceiling fan — center of the room, above the desk',
  'stack of cardboard boxes — foreground, left',
  'vintage radio — on top of the filing cabinets',
];

async function main() {
  // 1) zod schema: array / newline string / missing → normalized string[]
  const card = locationCardSchema.parse({ name: 'Detective office', description: 'Кабинет детектива на втором этаже.', visualPrompt: 'A cramped second-floor detective office at dusk, tall window, dust in the light.', setInventory: [...inventory, '  steel desk — center-left, facing the window wall  ', '', null] });
  ok(card.setInventory.length === inventory.length, 'duplicates/empties dropped');
  ok(card.setInventory[0] === inventory[0], 'entries trimmed and kept in order');
  const asString = locationCardSchema.parse({ name: 'X', description: 'y', visualPrompt: 'z', setInventory: inventory.join('\n') });
  ok(asString.setInventory.length === inventory.length, 'newline string accepted');
  const legacy = locationCardSchema.parse({ name: 'X', description: 'y', visualPrompt: 'z' });
  ok(Array.isArray(legacy.setInventory) && legacy.setInventory.length === 0, 'missing inventory → [] (idea creation never fails)');
  ok(hasFullSetInventory(card) && !hasFullSetInventory(legacy) && MIN_SET_INVENTORY === 8, 'full-inventory threshold = 8');
  ok(setInventoryRetryNote(['Office']).includes('"Office"') && setInventoryRetryNote([]).includes('12-30'), 'retry note names the incomplete locations');
  const sanitized = sanitizeLocationCard(card);
  ok(sanitized.setInventory.length === inventory.length && sanitized.setInventory.every((e) => e.includes(' — ')), 'sanitizer keeps object names and placement');

  // 2) DB serialization round-trip; legacy null
  const text = serializeSetInventory(card.setInventory);
  ok(typeof text === 'string' && text.split('\n').length === inventory.length, 'serialized one per line');
  assert.deepEqual(parseSetInventory(text), inventory); checks++;
  ok(serializeSetInventory([]) === null && parseSetInventory(null).length === 0 && parseSetInventory(undefined).length === 0, 'empty → null, null → []');
  ok(LOCATION_FIELD_RULES_TEXT_FOR_TESTS.includes('"setInventory"') && LOCATION_FIELD_RULES_TEXT_FOR_TESTS.includes('12-30'), 'idea prompts ask Astra for the inventory');

  // 3) location reference prompts: wide + layout contain EVERY inventory entry; legacy = old prompt
  const visual = 'A cramped second-floor detective office at dusk, tall window, dust in the light.';
  const wide = locationAnglePrompt(visual, 'Detective office', 'wide', text);
  const layout = locationAnglePrompt(visual, 'Detective office', 'layout', inventory);
  for (const e of inventory) { ok(wide.includes(e), `wide contains "${e}"`); ok(layout.includes(e), `layout contains "${e}"`); }
  ok(wide.includes('SET INVENTORY (every item must be visible, exact placement)') && layout.includes('SET INVENTORY (every item must be visible, exact placement)'), 'inventory block header');
  ok(wide.includes('highly DETAILED') && layout.includes('MUST show ALL listed items'), 'wide detailed, layout shows all');
  ok(layout.includes('2.5–3 m') && layout.includes('30–40°') && layout.includes('9:16') && wide.includes('no people') && layout.includes('no people'), 'layout geometry / no people / 9:16 preserved');
  const wideLegacy = locationAnglePrompt(visual, 'Detective office', 'wide');
  const layoutLegacy = locationAnglePrompt(visual, 'Detective office', 'layout', null);
  ok(!wideLegacy.includes('SET INVENTORY') && !layoutLegacy.includes('SET INVENTORY'), 'no inventory → pre-113 prompt');
  ok(wideLegacy === locationAnglePrompt(visual, 'Detective office', 'wide', ''), 'empty string = legacy');
  ok(formatSetInventoryBlock(null) === '' && setInventoryEntries('a\n\n b ').length === 2, 'block helpers');
  const many = Array.from({ length: MAX_INVENTORY_IN_PROMPT + 5 }, (_, i) => `object ${i} — spot ${i}`);
  const trimmed = formatSetInventoryBlock(many);
  ok(trimmed.includes(`object ${MAX_INVENTORY_IN_PROMPT - 1} —`) && !trimmed.includes(`object ${MAX_INVENTORY_IN_PROMPT} —`), 'prompt inventory capped at MAX_INVENTORY_IN_PROMPT');
  ok(wide.length < 6000 && layout.length < 6000, `reference prompts stay compact (${wide.length}/${layout.length})`);
  ok(VISUAL_STYLE_ID.length > 0, 'style id unchanged');

  // 4) episode script prompt (gpt-4o) carries the inventory + S14 rule; legacy → no block
  const input = {
    language: 'ru', synopsis: 'Synopsis.', season: { title: 'S', logline: 'L', episodes: [] },
    episode: { number: 1, title: 'Ep', logline: 'Logline', cliffhanger: 'Cliff', locationName: 'Detective office', locationDesc: 'INT — office — dusk', characters: ['Anna'], arcRole: 'setup', description: 'Anna finds the letter. She calls the number. The line goes dead.' },
    characters: [{ name: 'Anna', age: '30', role: 'lead', appearance: 'grey jacket', personality: 'calm', firstAppearance: 'ep1' }],
    previous: [], previousEnding: null,
  } as any;
  const withInv = episodeScriptUserPrompt({ ...input, locationInventory: text });
  ok(withInv.includes('LOCATION SET INVENTORY'), 'user prompt has the inventory block');
  for (const e of inventory) ok(withInv.includes(`- ${e}`), `script prompt lists "${e}"`);
  ok(withInv.includes('ONLY physical objects'), 'only-these-objects rule');
  const noInv = episodeScriptUserPrompt(input);
  ok(!noInv.includes('LOCATION SET INVENTORY') && locationInventoryBlock(null) === '' && locationInventoryBlock([]) === '', 'legacy location → unchanged prompt');
  const sys = episodeScriptSystemPrompt('ru', 1);
  ok(sys.includes('S14. SET INVENTORY') && sys.includes('"set"') && sys.includes('SET: <Location name>'), 'system prompt: S14 + per-scene SET line');
  ok(sys.includes('NO silent scenes') && sys.includes('English dialogue'), 'dialogue/structure rules untouched');

  // scene "set" field is optional; rendered into the script text
  const sceneBase = { number: 1, shotType: 'wide', durationSec: 30, locationDesc: 'INT — office — dusk', action: 'Anna sits at the steel desk.', dialogue: 'ANNA: "Hello."', videoPrompt: '[SHOT TYPE]: wide [ACTION]: Anna sits at the steel desk and picks up the telephone. [CHARACTER]: Anna', endState: 'WORLD: a. CAMERA: b', startState: 'WORLD: a. CAMERA: c' };
  ok(sceneScriptSchema.safeParse(sceneBase).success, 'scene without "set" still valid');
  const withSet = sceneScriptSchema.parse({ ...sceneBase, set: 'SET: Detective office — steel desk (center-left); rotary telephone (on the desk)' });
  ok(withSet.set?.startsWith('SET:'), '"set" kept');
  const rendered = renderEpisodeScriptText({ ...input.episode }, { visualIdentity: 'photoreal look of the episode', scenes: [withSet as any] } as any);
  ok(rendered.includes('SET: Detective office — steel desk'), 'script text shows the SET line once');
  ok(rendered.split('SET: Detective office').length === 2, 'SET not duplicated');
  const renderedPlain = renderEpisodeScriptText({ ...input.episode }, { visualIdentity: 'photoreal look of the episode', scenes: [{ ...sceneBase, set: 'Detective office — safe (under the desk)' } as any] } as any);
  ok(renderedPlain.includes('\nSET: Detective office — safe'), 'SET: prefix added when missing');

  // soft check: unknown objects only reported, never thrown
  const warnings = checkSceneSetInventory([{ number: 1, set: 'SET: Detective office — steel desk (center-left); grand piano (corner)' }, { number: 2, set: 'SET: Detective office — rotary telephone' }, { number: 3 }], text);
  ok(warnings.length === 1 && warnings[0].includes('scene 1') && warnings[0].includes('grand piano') && !warnings[0].includes('steel desk'), `soft inventory check: ${warnings.join(' | ')}`);
  ok(checkSceneSetInventory([{ number: 1, set: 'SET: x — grand piano' }], null).length === 0, 'no inventory → no warnings');

  // 5) video prompt: compact SET OBJECTS line (≤ 8, matched), absent without inventory
  const url = (s: string) => 'https' + '://media.invalid/' + VISUAL_STYLE_ID + '/' + s + '.png';
  const characters = [{ characterId: 'a', name: 'Anna', imageFull: url('anna'), appearance: 'grey jacket', tier: 'LEAD' }];
  const location = { id: 'loc', name: 'Detective office', imageUrl: url('wide'), imageReverse: url('layout'), setInventory: text };
  const dialogue = 'ANNA (quietly): "Put the telephone down. Open the safe."';
  const scene = { id: 's2', number: 2, episodeId: 'ep1', status: 'generating', videoPrompt: '[SHOT TYPE]: wide\n[ACTION]: Anna crosses from the door to the steel desk, switches on the floor lamp.\n[CHARACTER]: Anna\n[TRANSITION]: cut', dialogue, action: 'Anna leans on the filing cabinets.', startState: 'WORLD: Anna at desk.\nCAMERA: wide', endState: 'Anna sits.', promptOverride: null, endStateActual: null, lookCache: null } as any;
  const built = buildScenePrompt({ scene, characters, location, previous: null } as any);
  const setLine = built.prompt.split('\n').find((l) => l.startsWith(SCENE_SECTION.set));
  ok(!!setLine, 'video prompt has a SET OBJECTS line');
  for (const e of ['steel desk — center-left', 'rotary telephone — on the desk', 'small safe — under the desk', 'brass floor lamp — behind the armchair', 'metal door with frosted glass', 'wall of filing cabinets — back wall']) ok(setLine!.includes(e), `matched "${e}" with placement`);
  ok(!setLine!.includes('ceiling fan') && !setLine!.includes('vintage radio') && !setLine!.includes('coat rack'), 'unmentioned objects are NOT injected');
  ok(setLine!.split(';').length <= SET_OBJECTS_CAP && SET_OBJECTS_CAP === 8, `≤ ${SET_OBJECTS_CAP} objects`);
  // Stage 121 — the SET OBJECTS line now also repeats the wall-anchored objects (WALL-ANCHORED PLACEMENT) to
  // weld them to the architecture; still one compact line.
  ok(setLine!.length < 1000, `SET OBJECTS line compact (${setLine!.length} chars)`);
  const all = matchSetInventoryInText(inventory, inventory.join(' '));
  ok(all.length === SET_OBJECTS_CAP, 'matcher hard-caps at 8 even when everything matches');
  ok(matchSetInventoryInText(text, '').length === 0 && matchSetInventoryInText(null, 'steel desk').length === 0 && buildSetObjectsSection([]) === '', 'no text / no inventory → nothing');
  const legacyBuilt = buildScenePrompt({ scene, characters, location: { ...location, setInventory: null }, previous: null } as any);
  ok(!legacyBuilt.prompt.includes(SCENE_SECTION.set), 'legacy location → no SET OBJECTS line');
  // Stage 121 — inventory now also carries the WALL-ANCHORED PLACEMENT repeat; still a bounded addition.
  ok(built.prompt.length - legacyBuilt.prompt.length < 1100, `inventory adds a bounded amount to the video prompt (+${built.prompt.length - legacyBuilt.prompt.length})`);
  ok(built.prompt.length < 13000, `video prompt stays far below the 24k bug (${built.prompt.length})`);

  console.log(`test-stage113: OK (${checks} checks)`);
}
main().catch((e) => { console.error('test-stage113 FAILED:', e); process.exit(1); });
