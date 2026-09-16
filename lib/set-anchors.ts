/**
 * Stage 140 — PERSISTENT SET ANCHORS (pure).
 *
 * A recurring STORYBOARD bug: a large piece of set furniture (e.g. a big librarian's desk with books,
 * a telegraph apparatus and papers on it) is present in one board of a scene and then simply GONE in the
 * next board (a reverse angle of the same location shows the characters standing on an empty floor).
 *
 * Root cause: the episode `locationDesc` already describes that furniture, but it only ever reaches the
 * board prompt as ambient background flavour (the `LOCATION:` line) — nothing raises it to a HARD
 * persistence mandate, so the model happily drops it on a re-frame / reverse shot.
 *
 * Fix (content of the prompt only — NO hard-fail): deterministically derive the location's LARGE, NON-
 * PORTABLE set pieces (primarily from `locationDesc`, secondarily from the boards' own action text) and
 * emit ONE emphatic "PERSISTENT SET PIECES" line into EVERY board's frame prompt. That line pins the
 * pieces as the SAME objects in every board and every camera angle — they may be fully in frame, cropped
 * at an edge, or just outside the frame depending on this board's framing, but they are NEVER removed,
 * emptied or teleported; a reverse angle shows the SAME pieces from the other side, not an empty floor.
 *
 * No network, no LLM, no DB — safe to unit-test and reuse in a "show full prompt" preview.
 */

/**
 * Head-nouns of LARGE, non-portable set furniture / fixtures that anchor a location. Multi-word entries
 * come FIRST inside their alternation so the phrase extractor prefers "writing desk" over bare "desk".
 * Architecture (wall/column/window/door/floor) is deliberately EXCLUDED — it is already owned by the
 * geometry plate. Small portable props (a book, a tome, a knife, a lamp on its own) are excluded as
 * head-nouns too, but they are allowed to appear as the CONTENTS resting on a surface (trailing clause).
 */
export const SET_PIECE_KEYWORDS: string[] = [
  // desks / tables (multi-word first)
  "writing desk", "reading desk", "roll-top desk", "operating table", "examination table",
  "conference table", "dining table", "map table", "work table", "side table", "coffee table",
  "pool table", "billiard table", "drafting table", "desk", "table",
  // counters / work surfaces
  "workbench", "counter", "bar",
  // seating
  "pew", "bench", "settee", "couch", "sofa", "armchair", "chair", "stool", "throne",
  // storage
  "bookshelf", "bookcase", "shelves", "shelf", "cabinet", "cupboard", "dresser", "sideboard",
  "wardrobe", "chest", "crate", "barrel", "trunk", "coffin", "casket",
  // fixtures
  "lectern", "podium", "pulpit", "altar", "pedestal", "console", "vanity",
  "fireplace", "hearth", "stove", "oven", "furnace", "sink", "basin", "fountain",
  "statue", "piano", "organ", "bed",
];

/** Words that stop the backward scan for adjectives (articles, prepositions, verbs, conjunctions). */
const STOP_WORDS = new Set<string>([
  "a", "an", "the", "and", "or", "but", "with", "of", "in", "on", "at", "to", "by", "from",
  "for", "as", "into", "onto", "near", "beside", "behind", "before", "over", "under", "while",
  "holds", "hold", "holding", "has", "have", "had", "is", "are", "was", "were", "be", "being",
  "occupy", "occupies", "create", "creates", "stands", "stand", "sits", "sit", "stood", "sat",
  "that", "which", "where", "there", "here", "this", "these", "those", "its", "their",
]);

/** Connectors that introduce the CONTENTS resting on a set piece (captured as a trailing clause). */
const TRAILING_CONNECTOR =
  /^(with|holds?|holding|topped with|covered (?:in|with)|stacked with|bearing|carr(?:ies|ying)|piled with|strewn with|laden with|full of|displaying|scattered with|cluttered with|set with|lined with)\b/i;

const MAX_ADJECTIVES = 3;
const MAX_ANCHORS = 8;
const MAX_ANCHOR_WORDS = 24;

/** Stem a head-noun for dedup: lowercase and strip a single trailing plural "s" (shelves→shelf handled by list). */
function stemHead(head: string): string {
  const h = head.toLowerCase().trim();
  const last = h.split(/\s+/).pop() ?? h;
  return last.endsWith("s") && last.length > 3 ? last.slice(0, -1) : last;
}

/** Build one alternation regex for all keywords (longest first so multi-word wins). */
function keywordAlternation(): RegExp {
  const escaped = SET_PIECE_KEYWORDS
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));
  // Allow an optional plural suffix (chair→chairs, table→tables, bench→benches) — stemHead re-normalizes.
  return new RegExp(`\\b(${escaped.join("|")})(?:e?s)?\\b`, "i");
}

const KEYWORD_RE = keywordAlternation();

/** Trim / cap an anchor phrase to a sane word count. */
function capWords(phrase: string, max: number): string {
  const words = phrase.trim().split(/\s+/);
  return words.length <= max ? phrase.trim() : words.slice(0, max).join(" ");
}

/**
 * Extract one anchor phrase for the FIRST set-piece head-noun found in a sentence:
 *   [up to 3 leading adjectives] + head [+ trailing "with/holds ..." contents clause].
 * Returns null when the sentence has no set piece.
 */
function extractAnchorFromSentence(sentence: string): { head: string; phrase: string } | null {
  const m = KEYWORD_RE.exec(sentence);
  if (!m) return null;
  const head = m[0];
  const headStart = m.index;
  const headEnd = m.index + head.length;

  // backward: gather up to MAX_ADJECTIVES alphabetic modifiers immediately before the head
  const before = sentence.slice(0, headStart).trim();
  const beforeTokens = before.length ? before.split(/\s+/) : [];
  const adjectives: string[] = [];
  for (let i = beforeTokens.length - 1; i >= 0 && adjectives.length < MAX_ADJECTIVES; i--) {
    const raw = beforeTokens[i];
    const tok = raw.replace(/[^A-Za-z-]/g, "");
    if (!tok) break;
    if (/[.;:,!?()"'«»]/.test(raw)) break; // punctuation boundary
    if (STOP_WORDS.has(tok.toLowerCase())) break;
    adjectives.unshift(tok);
  }

  // forward: if a contents connector immediately follows the head, capture up to the next clause end
  let trailing = "";
  const after = sentence.slice(headEnd).replace(/^\s+/, "");
  if (TRAILING_CONNECTOR.test(after)) {
    const clause = after.split(/[.;\n]/)[0] ?? "";
    trailing = clause.trim();
  }

  const phrase = capWords(
    [adjectives.join(" "), head, trailing].map((s) => s.trim()).filter(Boolean).join(" "),
    MAX_ANCHOR_WORDS,
  );
  return { head, phrase };
}

/** All set-piece anchors from a free-text description, in order of appearance, one per sentence-piece. */
function anchorsFromText(text: string): { head: string; phrase: string }[] {
  const out: { head: string; phrase: string }[] = [];
  const pieces = (text ?? "").split(/[.;!?\n]+/);
  for (const piece of pieces) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    // a single sentence may list several pieces — scan repeatedly, chopping past each head found
    let rest = trimmed;
    let guard = 0;
    while (rest && guard < 6) {
      const found = extractAnchorFromSentence(rest);
      if (!found) break;
      out.push(found);
      const idx = rest.toLowerCase().indexOf(found.head.toLowerCase());
      rest = idx >= 0 ? rest.slice(idx + found.head.length) : "";
      guard += 1;
    }
  }
  return out;
}

/**
 * Deterministically derive the persistent set-piece anchors for a scene.
 *
 * @param locationDesc  the episode's canonical location description (PRIMARY source — always included).
 * @param boardActions  each board's English action text (SECONDARY — only adds a NEW head-noun that
 *                       carries its own descriptor; a bare "the table" from a board never adds an anchor,
 *                       because with no description it cannot be pinned reliably across angles).
 * @returns             a deduped, capped list of anchor phrases (large furniture + its contents).
 */
export function deriveSetAnchors(locationDesc: string, boardActions: string[] = []): string[] {
  const byStem = new Map<string, string>(); // stem → richest phrase

  const consider = (head: string, phrase: string, requireDescriptor: boolean) => {
    const stem = stemHead(head);
    // a descriptor means: the phrase carries more than just an article + the head noun
    const words = phrase.trim().split(/\s+/).filter((w) => !/^(a|an|the)$/i.test(w));
    const hasDescriptor = words.length > head.trim().split(/\s+/).length;
    if (requireDescriptor && !hasDescriptor) return;
    const prev = byStem.get(stem);
    if (!prev || phrase.length > prev.length) byStem.set(stem, phrase);
  };

  // PRIMARY: everything the location description establishes
  for (const { head, phrase } of anchorsFromText(locationDesc ?? "")) consider(head, phrase, false);

  // SECONDARY: board actions may introduce a described piece not in the location text
  for (const action of boardActions ?? []) {
    for (const { head, phrase } of anchorsFromText(action ?? "")) consider(head, phrase, true);
  }

  return Array.from(byStem.values()).slice(0, MAX_ANCHORS);
}

/**
 * Build the emphatic PERSISTENT SET PIECES line for a board frame prompt. Empty string when there are
 * no anchors (the caller filters it out, so the prompt is byte-identical to before on locations with no
 * detectable set furniture).
 */
export function buildSetAnchorsLine(anchors: string[]): string {
  if (!anchors || anchors.length === 0) return "";
  const list = anchors.map((a) => a.trim()).filter(Boolean).join("; ");
  if (!list) return "";
  return (
    `PERSISTENT SET PIECES (the established large furniture of this location — the SAME physical objects exist in EVERY board of this scene): ${list}. ` +
    "These pieces MUST stay physically present and identical across every board and every camera angle — the same model, size, materials, contents and placement as established. " +
    "Depending on THIS board's framing they may be fully in frame, partially cropped at the edge, or just outside the visible frame, but they are NEVER removed, replaced, emptied, resized, restyled, cleared away or teleported between boards; a reverse angle shows the SAME pieces from the opposite side (never an empty floor where a piece stood). " +
    "Whatever rests ON a surface (books, papers, ledgers, stamps, lamps, apparatus) stays on that same surface. Any piece set against a wall keeps its back flush against that same wall at every angle."
  );
}
