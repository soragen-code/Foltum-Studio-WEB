/**
 * Stage 80 — robust LLM JSON parsing (fix "Unterminated string in JSON at position …" on the scenes page).
 *
 * The scene-revise route parses the model answer with chatJSON → safeJsonParse. When the model hits its
 * token cap the JSON is truncated mid-string and the raw exception used to surface to the user. These
 * checks lock in: (1) valid JSON parses, (2) fenced JSON parses, (3) a truncated blob is REPAIRED into
 * usable data instead of throwing, (4) hopeless input throws a short Russian message, not the raw error.
 */
import { safeJsonParse, repairTruncatedJson, stripJsonFences } from "../lib/ai";

let passed = 0;
function check(name: string, cond: boolean) {
  if (!cond) throw new Error(`FAIL: ${name}`);
  passed++;
  console.log(`ok  ${name}`);
}

// 1. Plain valid JSON round-trips.
const good = safeJsonParse<{ a: number; b: string }>('{"a":1,"b":"hi"}');
check("valid JSON parses", good.a === 1 && good.b === "hi");

// 2. ```json fenced output is stripped and parsed.
const fenced = safeJsonParse<{ x: number }>('```json\n{"x":42}\n```');
check("fenced JSON parses", fenced.x === 42);

// 3. Truncated blob: string cut off mid-value → repaired to valid JSON keeping earlier fields.
const truncated = '{"action":"She turns","dialogue":"Hello there","videoPrompt":"a long prompt that gets cut o';
const repairedText = repairTruncatedJson(truncated);
check("repairTruncatedJson returns text", typeof repairedText === "string");
const parsedTrunc = JSON.parse(repairedText as string);
check("repaired truncation keeps complete fields", parsedTrunc.action === "She turns" && parsedTrunc.dialogue === "Hello there");
check("repaired truncation closes dangling string", typeof parsedTrunc.videoPrompt === "string");

// 4. safeJsonParse recovers the same truncated blob without throwing.
const recovered = safeJsonParse<any>(truncated);
check("safeJsonParse recovers truncated JSON", recovered.action === "She turns");

// 5. Truncated array of objects (music-plan shape) is repaired.
const arrTrunc = '{"scenes":[{"index":0,"mood":"tense","intensity":0.6},{"index":1,"mood":"myst';
const arr = safeJsonParse<{ scenes: any[] }>(arrTrunc);
check("safeJsonParse repairs truncated array", Array.isArray(arr.scenes) && arr.scenes[0].index === 0);

// 6. Dangling trailing comma is dropped.
const dangling = safeJsonParse<{ scenes: any[] }>('{"scenes":[{"index":0}],');
check("dangling trailing comma handled", Array.isArray(dangling.scenes));

// 7. Hopeless / non-JSON input throws a short Russian message, NOT the raw "Unterminated string".
let threwFriendly = false;
try {
  safeJsonParse("this is not json at all");
} catch (e) {
  const msg = (e as Error).message;
  threwFriendly = msg.includes("incomplete response") && !/Unterminated string/i.test(msg);
}
check("non-JSON throws friendly error (English, Stage 87)", threwFriendly);

// 8. repairTruncatedJson returns null for non-JSON-looking text.
check("repairTruncatedJson null for non-JSON", repairTruncatedJson("hello world") === null);

// 9. stripJsonFences still exported and works.
check("stripJsonFences unwraps fences", stripJsonFences('```\n{"a":1}\n```').trim() === '{"a":1}');

console.log(`\n${passed} checks passed`);
