import { diffArrays, diffLines } from "diff";

type Block = { kind: "equal"; lines: string[] } | { kind: "change"; removed: string[]; added: string[] };

/** A run of text that is either shared by both sides or replaced (`del` → `ins`). Text may contain newlines. */
type Segment = { kind: "equal"; old: string; new: string } | { kind: "change"; del: string; ins: string };

interface Side {
  no: number;
  html: string;
  cls: string;
}

const CONTEXT_LINES = 3;
const MIN_FOLDED_LINES = 4;
const WORD_DIFF_TIMEOUT_MS = 2000;
/** Lines below this similarity are shown as separate removed/added rows instead of side by side. */
const MIN_LINE_SIMILARITY = 0.4;
/** Sentences below this similarity are replaced as a whole instead of diffed word by word. */
const MIN_SENTENCE_SIMILARITY = 0.5;
/** Edited text sharing less than this with the original is shown as separate removed/added rows in unified view. */
const MIN_INLINE_SHARE = 0.25;
const NEWLINE_MATCH_SCORE = 0.5;
const MAX_ALIGN_CELLS = 10000;

const TOKEN_RE = /[^\S\n]*(?:[\p{L}\p{N}_]+(?:['’][\p{L}\p{N}_]+)*|\S)|\n|[^\S\n]+/gu;
const WORD_RE = /[\p{L}\p{N}]/u;
const SENTENCE_END_RE = /[.!?…]+["'”’)\]]*\s+/g;
const ABBREVIATIONS = new Set([
  "dr",
  "mr",
  "mrs",
  "ms",
  "prof",
  "sr",
  "jr",
  "st",
  "vs",
  "etc",
  "e.g",
  "i.e",
  "fig",
  "no",
  "inc",
  "ltd",
  "co",
  "u.s",
]);

export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Highlights `text`, leaving surrounding whitespace unhighlighted unless the change is only whitespace. */
function mark(text: string, className: string): string {
  if (!text) return "";
  const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  if (!core) return `<span class="${className}">${escapeHtml(text)}</span>`;
  return `${escapeHtml(lead)}<span class="${className}">${escapeHtml(core)}</span>${escapeHtml(trail)}`;
}

function splitLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function toBlocks(original: string, changed: string): Block[] {
  const blocks: Block[] = [];
  let pending: Extract<Block, { kind: "change" }> | undefined;

  for (const change of diffLines(original, changed)) {
    if (change.value === "") continue;
    const lines = splitLines(change.value);
    if (change.added || change.removed) {
      if (!pending) {
        pending = { kind: "change", removed: [], added: [] };
        blocks.push(pending);
      }
      (change.added ? pending.added : pending.removed).push(...lines);
    } else {
      pending = undefined;
      blocks.push({ kind: "equal", lines });
    }
  }
  return blocks;
}

type Pair = [number | undefined, number | undefined];

function tokenize(text: string): string[] {
  return text.match(TOKEN_RE) ?? [];
}

function tokenWeight(token: string): number {
  if (WORD_RE.test(token)) return 1;
  return /\S/.test(token) ? 0.25 : 0;
}

/** Roughly the number of words in `text`; punctuation counts a little, whitespace not at all. */
function textWeight(text: string): number {
  return tokenize(text).reduce((sum, token) => sum + tokenWeight(token), 0);
}

function sameText(a: string, b: string): boolean {
  return a === b || a.trim() === b.trim();
}

function pushSegment(segments: Segment[], seg: Segment) {
  const last = segments[segments.length - 1];
  if (last?.kind === "equal" && seg.kind === "equal") {
    last.old += seg.old;
    last.new += seg.new;
  } else if (last?.kind === "change" && seg.kind === "change") {
    last.del += seg.del;
    last.ins += seg.ins;
  } else {
    segments.push({ ...seg });
  }
}

/**
 * Word diff where whitespace never anchors a match: each token carries its leading whitespace and tokens
 * compare by content, so moved phrases stay intact instead of being paired with whatever sits at the same spot.
 */
function diffTokens(a: string, b: string, maxEditRatio?: number): Segment[] | undefined {
  const ta = tokenize(a);
  const tb = tokenize(b);
  const changes = diffArrays(ta, tb, {
    comparator: (x, y) => x === y || (x !== "\n" && y !== "\n" && x.trim() === y.trim()),
    timeout: WORD_DIFF_TIMEOUT_MS,
    ...(maxEditRatio ? { maxEditLength: Math.ceil((ta.length + tb.length) * maxEditRatio) } : {}),
  });
  if (!changes) return undefined;

  const segments: Segment[] = [];
  let i = 0;
  let j = 0;
  for (const change of changes) {
    const n = change.count ?? change.value.length;
    if (change.removed) {
      pushSegment(segments, { kind: "change", del: ta.slice(i, (i += n)).join(""), ins: "" });
    } else if (change.added) {
      pushSegment(segments, { kind: "change", del: "", ins: tb.slice(j, (j += n)).join("") });
    } else {
      pushSegment(segments, {
        kind: "equal",
        old: ta.slice(i, (i += n)).join(""),
        new: tb.slice(j, (j += n)).join(""),
      });
    }
  }
  return segments;
}

function segmentSimilarity(segments: Segment[], a: string, b: string): number {
  const total = textWeight(a) + textWeight(b);
  if (total === 0) return 1;
  const common = segments.reduce((sum, s) => (s.kind === "equal" ? sum + textWeight(s.old) : sum), 0);
  return (2 * common) / total;
}

/**
 * Folds tiny matches between two edits into one larger edit, so "A x B" → "C x D" reads as one replaced phrase
 * rather than a scatter of single-word swaps around a coincidental "the" or comma.
 */
function absorbShortEqualities(segments: Segment[]): Segment[] {
  const out = segments.map((s) => ({ ...s }));
  const size = (s: Extract<Segment, { kind: "change" }>) => Math.max(textWeight(s.del), textWeight(s.ins));
  let k = 1;
  while (k < out.length - 1) {
    const prev = out[k - 1];
    const eq = out[k];
    const next = out[k + 1];
    if (prev.kind === "change" && eq.kind === "equal" && next.kind === "change") {
      const weight = textWeight(eq.old);
      if (weight < 1 || (weight < size(prev) && weight < size(next))) {
        out.splice(k - 1, 3, { kind: "change", del: prev.del + eq.old + next.del, ins: prev.ins + eq.new + next.ins });
        k = Math.max(1, k - 2);
        continue;
      }
    }
    k++;
  }
  return out;
}

function splitSentences(line: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (const match of line.matchAll(SENTENCE_END_RE)) {
    const end = match.index + match[0].length;
    const word = /(\S+?)[.!?…]*$/.exec(line.slice(start, match.index + 1))?.[1] ?? "";
    const isAbbreviation = ABBREVIATIONS.has(word.toLowerCase()) || /^\p{Lu}$/u.test(word);
    if (isAbbreviation || /^\p{Ll}/u.test(line.slice(end))) continue;
    sentences.push(line.slice(start, end));
    start = end;
  }
  if (start < line.length) sentences.push(line.slice(start));
  return sentences;
}

/** Order-preserving alignment maximizing total similarity; `sim` returns 0 for items that must not pair. */
function align(n: number, m: number, sim: (i: number, j: number) => number): Pair[] {
  if (n === 0 || m === 0 || n * m > MAX_ALIGN_CELLS) {
    return Array.from({ length: Math.max(n, m) }, (_, i) => [i < n ? i : undefined, i < m ? i : undefined]);
  }

  const scores = Array.from({ length: n }, (_, i) => Array.from({ length: m }, (_, j) => sim(i, j)));
  const best = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const pair = scores[i][j] > 0 ? scores[i][j] + best[i + 1][j + 1] : -1;
      best[i][j] = Math.max(pair, best[i + 1][j], best[i][j + 1]);
    }
  }

  const result: Pair[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (scores[i][j] > 0 && best[i][j] === scores[i][j] + best[i + 1][j + 1]) result.push([i++, j++]);
    else if (best[i][j] === best[i + 1][j]) result.push([i++, undefined]);
    else result.push([undefined, j++]);
  }
  while (i < n) result.push([i++, undefined]);
  while (j < m) result.push([undefined, j++]);
  return result;
}

function lineSimilarity(a: string, b: string): number {
  if (sameText(a, b)) return 1;
  const segments = diffTokens(a, b, 1 - MIN_LINE_SIMILARITY / 2);
  const score = segments ? segmentSimilarity(segments, a, b) : 0;
  return score >= MIN_LINE_SIMILARITY ? score : 0;
}

/** Pairs similar removed/added lines into rows; unpaired lines get `undefined` on the other side. */
function alignLines(removed: string[], added: string[]): Pair[] {
  return align(removed.length, added.length, (i, j) => lineSimilarity(removed[i], added[j]));
}

/** Sentences of every line, with "\n" units marking line breaks. */
function toUnits(lines: string[]): string[] {
  return lines.flatMap((line, i) => {
    const sentences = splitSentences(line);
    const units = sentences.length ? sentences : [""];
    return i === 0 ? units : ["\n", ...units];
  });
}

/** Sizes of matched unit runs: one sentence to one, or one sentence to two (optionally across a line break). */
const SPANS: [number, number][] = [
  [1, 1],
  [1, 2],
  [2, 1],
  [1, 3],
  [3, 1],
];

/** True for a run of one sentence, two sentences, or two sentences separated by a line break. */
function isSentenceRun(units: string[], start: number, length: number): boolean {
  if (start + length > units.length) return false;
  const run = units.slice(start, start + length);
  if (run.some((u) => u === "")) return false;
  if (length === 3) return run[0] !== "\n" && run[1] === "\n" && run[2] !== "\n";
  return run.every((u) => u !== "\n");
}

/**
 * Diffs a changed block sentence by sentence. Sentences are matched across the whole block (so text that moved
 * to another line or paragraph still lines up, and a sentence split in two still matches its original); a match
 * that is mostly rewritten is replaced as a whole, otherwise it gets a cleaned-up word diff.
 */
function diffBlock(removed: string[], added: string[]): Segment[] {
  const a = toUnits(removed);
  const b = toUnits(added);
  const n = a.length;
  const m = b.length;
  const wordDiffs = new Map<string, Segment[]>();

  const wordDiff = (i: number, di: number, j: number, dj: number) => {
    const key = `${i}:${di}:${j}:${dj}`;
    if (!wordDiffs.has(key)) {
      const x = a.slice(i, i + di).join("");
      const y = b.slice(j, j + dj).join("");
      const wx = textWeight(x);
      const wy = textWeight(y);
      const segments =
        Math.min(wx, wy) * 3 < Math.max(wx, wy) ? undefined : diffTokens(x, y, 1 - MIN_SENTENCE_SIMILARITY / 2);
      const similar = segments && segmentSimilarity(segments, x, y) >= MIN_SENTENCE_SIMILARITY;
      wordDiffs.set(key, similar ? segments : []);
    }
    return wordDiffs.get(key)!;
  };

  const score = (i: number, di: number, j: number, dj: number): number => {
    if (di === 1 && dj === 1) {
      if (a[i] === "\n" || b[j] === "\n") return a[i] === b[j] ? NEWLINE_MATCH_SCORE : 0;
      if (sameText(a[i], b[j])) return 1;
    }
    if (!isSentenceRun(a, i, di) || !isSentenceRun(b, j, dj)) return 0;
    const segments = wordDiff(i, di, j, dj);
    return segments.length ? segmentSimilarity(segments, a.slice(i, i + di).join(""), b.slice(j, j + dj).join("")) : 0;
  };

  const steps: [number, number][] = [];
  if (n * m > MAX_ALIGN_CELLS) {
    for (let k = 0; k < Math.max(n, m); k++) steps.push(k < n && k < m ? [1, 1] : k < n ? [1, 0] : [0, 1]);
  } else {
    const best = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    const choice = Array.from({ length: n + 1 }, () => new Array<[number, number]>(m + 1));
    for (let i = n; i >= 0; i--) {
      for (let j = m; j >= 0; j--) {
        if (i === n && j === m) continue;
        let top = -1;
        let pick: [number, number] = [0, 1];
        for (const [di, dj] of SPANS) {
          if (i + di > n || j + dj > m) continue;
          const s = score(i, di, j, dj);
          if (s > 0 && s + best[i + di][j + dj] > top) [top, pick] = [s + best[i + di][j + dj], [di, dj]];
        }
        if (i < n && best[i + 1][j] > top) [top, pick] = [best[i + 1][j], [1, 0]];
        if (j < m && best[i][j + 1] > top) [top, pick] = [best[i][j + 1], [0, 1]];
        best[i][j] = top;
        choice[i][j] = pick;
      }
    }
    for (let i = 0, j = 0; i < n || j < m;) {
      const [di, dj] = choice[i][j];
      steps.push([di, dj]);
      i += di;
      j += dj;
    }
  }

  const out: Segment[] = [];
  let i = 0;
  let j = 0;
  for (const [di, dj] of steps) {
    const del = a.slice(i, i + di).join("");
    const ins = b.slice(j, j + dj).join("");
    if (di && dj && sameText(del, ins) && del.split("\n").length === ins.split("\n").length) {
      pushSegment(out, { kind: "equal", old: del, new: ins });
    } else {
      const words = di && dj && isSentenceRun(a, i, di) && isSentenceRun(b, j, dj) ? wordDiff(i, di, j, dj) : [];
      if (words.length) absorbShortEqualities(words).forEach((s) => pushSegment(out, s));
      else pushSegment(out, { kind: "change", del, ins });
    }
    i += di;
    j += dj;
  }
  return out;
}

/** Splits one side of a block diff back into per-line HTML. Lines with nothing in common are left unmarked. */
function renderSide(segments: Segment[], side: "old" | "new", count: number): string[] {
  const lines: string[] = [];
  const cls = side === "old" ? "w-del" : "w-ins";
  let html = "";
  let plain = "";
  let shared = false;
  const flush = () => {
    lines.push(shared ? html : escapeHtml(plain));
    html = plain = "";
    shared = false;
  };

  for (const seg of segments) {
    const text = seg.kind === "equal" ? seg[side] : side === "old" ? seg.del : seg.ins;
    text.split("\n").forEach((piece, k) => {
      if (k > 0) flush();
      html += seg.kind === "equal" ? escapeHtml(piece) : mark(piece, cls);
      plain += piece;
      if (seg.kind === "equal" && WORD_RE.test(piece)) shared = true;
    });
  }
  flush();
  return lines.slice(0, count);
}

/** One unified-view row of inline edits. `old`/`new` are the line indices it shows content from. */
interface InlineRow {
  html: string;
  plain: string;
  /** Set when the row ends at a line break that exists on only one side. */
  brk?: "del" | "ins";
  old?: number;
  new?: number;
  shared: number;
  oldWeight: number;
  newWeight: number;
}

/** Lays a block diff out as track-changes rows, breaking a row wherever either side has a line break. */
function inlineRows(segments: Segment[], oldCount: number, newCount: number): InlineRow[] {
  const blank = (): InlineRow => ({ html: "", plain: "", shared: 0, oldWeight: 0, newWeight: 0 });
  const rows: InlineRow[] = [];
  let row = blank();
  let oi = 0;
  let ni = 0;

  const add = (text: string, kind: "equal" | "del" | "ins") => {
    if (!text) return;
    const cls = kind === "del" ? "w-del" : "w-ins";
    text.split("\n").forEach((piece, k) => {
      if (k > 0) {
        if (kind !== "equal") row.brk = kind;
        rows.push(row);
        row = blank();
        if (kind !== "ins") oi++;
        if (kind !== "del") ni++;
      }
      if (!piece && k === 0) return;
      if (kind !== "ins" && oi < oldCount) row.old = oi;
      if (kind !== "del" && ni < newCount) row.new = ni;
      const weight = textWeight(piece);
      row.html += kind === "equal" ? escapeHtml(piece) : mark(piece, cls);
      row.plain += piece;
      if (kind === "equal") row.shared += weight;
      if (kind !== "ins") row.oldWeight += weight;
      if (kind !== "del") row.newWeight += weight;
    });
  };

  for (const seg of segments) {
    if (seg.kind === "equal") {
      add(seg.new, "equal");
    } else {
      add(seg.del, "del");
      add(seg.ins, "ins");
    }
  }
  rows.push(row);
  if (oldCount && rows.every((r) => r.old === undefined)) rows[0].old = 0;
  if (newCount && rows.every((r) => r.new === undefined)) rows[0].new = 0;
  return rows.filter((r) => r.old !== undefined || r.new !== undefined);
}

/** Splits rows into runs connected by a shared old or new line, e.g. one paragraph split into two. */
function groupRows(rows: InlineRow[]): InlineRow[][] {
  const groups: InlineRow[][] = [];
  rows.forEach((row, i) => {
    const prev = rows[i - 1];
    const linked =
      prev && ((row.old !== undefined && row.old === prev.old) || (row.new !== undefined && row.new === prev.new));
    if (linked) groups[groups.length - 1].push(row);
    else groups.push([row]);
  });
  return groups;
}

/**
 * Unified view keeps edited text in place as one paragraph with deletions struck through next to insertions.
 * Only a group that is almost entirely rewritten falls back to separate removed/added rows.
 */
function renderUnifiedBlock(
  segments: Segment[],
  block: { removed: string[]; added: string[] },
  left: string[],
  right: string[],
  oldNo: number,
  newNo: number,
): string {
  let html = "";
  for (const group of groupRows(inlineRows(segments, block.removed.length, block.added.length))) {
    const shared = group.reduce((sum, r) => sum + r.shared, 0);
    const total = group.reduce((sum, r) => sum + r.oldWeight + r.newWeight, 0);

    if (total > 0 && (2 * shared) / total < MIN_INLINE_SHARE) {
      const olds = [...new Set(group.flatMap((r) => (r.old === undefined ? [] : [r.old])))];
      const news = [...new Set(group.flatMap((r) => (r.new === undefined ? [] : [r.new])))];
      olds.forEach((i) => (html += unifiedRow(oldNo + i, "", "−", left[i], "l-del")));
      news.forEach((j) => (html += unifiedRow("", newNo + j, "+", right[j], "l-ins")));
      continue;
    }

    group.forEach((row, k) => {
      const prev = group[k - 1];
      const next = group[k + 1];
      const oldLabel = row.old !== undefined && row.old !== prev?.old ? oldNo + row.old : "";
      const newLabel = row.new !== undefined && row.new !== prev?.new ? newNo + row.new : "";
      const continues =
        (row.brk === "ins" && row.old !== undefined && next?.old === row.old) ||
        (row.brk === "del" && row.new !== undefined && next?.new === row.new);
      const body = row.html + (continues ? `<span class="w-${row.brk} brk"></span>` : "");
      if (row.new === undefined)
        html += unifiedRow(oldLabel, "", "−", row.shared ? body : escapeHtml(row.plain), "l-del");
      else if (row.old === undefined)
        html += unifiedRow("", newLabel, "+", row.shared ? body : escapeHtml(row.plain), "l-ins");
      else html += unifiedRow(oldLabel, newLabel, "", body, "l-mod");
    });
  }
  return html;
}

function splitRow(left: Side | undefined, right: Side | undefined): string {
  const cell = (side: Side | undefined) =>
    side
      ? `<span class="no ${side.cls}">${side.no}</span><span class="code ${side.cls}">${side.html}</span>`
      : `<span class="no empty"></span><span class="code empty"></span>`;
  return `<div class="row split">${cell(left)}${cell(right)}</div>`;
}

function unifiedRow(oldNo: number | "", newNo: number | "", sign: string, html: string, cls: string): string {
  return (
    `<div class="row unified"><span class="no ${cls}">${oldNo}</span><span class="no ${cls}">${newNo}</span>` +
    `<span class="sign ${cls}">${sign}</span><span class="code ${cls}">${html}</span></div>`
  );
}

function foldEqual(rows: string[], isFirst: boolean, isLast: boolean): string {
  const head = isFirst ? 0 : CONTEXT_LINES;
  const tail = isLast ? 0 : CONTEXT_LINES;
  const hidden = rows.length - head - tail;
  if (hidden < MIN_FOLDED_LINES) return rows.join("");

  const label = `${hidden} unchanged line${hidden === 1 ? "" : "s"}`;
  return (
    rows.slice(0, head).join("") +
    `<details class="fold"><summary>${label}</summary>${rows.slice(head, rows.length - tail).join("")}</details>` +
    rows.slice(rows.length - tail).join("")
  );
}

/**
 * Split view shows paired lines side by side with each side's edits; unified view shows edits inline.
 */
function renderRowViews(blocks: Block[]) {
  let oldNo = 1;
  let newNo = 1;
  let split = "";
  let unified = "";

  blocks.forEach((block, index) => {
    const isFirst = index === 0;
    const isLast = index === blocks.length - 1;

    if (block.kind === "equal") {
      const splitRows: string[] = [];
      const unifiedRows: string[] = [];
      for (const line of block.lines) {
        const html = escapeHtml(line);
        splitRows.push(splitRow({ no: oldNo, html, cls: "" }, { no: newNo, html, cls: "" }));
        unifiedRows.push(unifiedRow(oldNo, newNo, "", html, ""));
        oldNo++;
        newNo++;
      }
      split += foldEqual(splitRows, isFirst, isLast);
      unified += foldEqual(unifiedRows, isFirst, isLast);
      return;
    }

    const { removed, added } = block;
    const segments = diffBlock(removed, added);
    const left = renderSide(segments, "old", removed.length);
    const right = renderSide(segments, "new", added.length);
    const side = (i: number | undefined, start: number, html: string[], cls: string) =>
      i === undefined ? undefined : { no: start + i, html: html[i], cls };

    for (const [ri, ai] of alignLines(removed, added)) {
      split += splitRow(side(ri, oldNo, left, "l-del"), side(ai, newNo, right, "l-ins"));
    }
    unified += renderUnifiedBlock(segments, block, left, right, oldNo, newNo);

    oldNo += removed.length;
    newNo += added.length;
  });

  return { split, unified };
}

export function renderDiffHtml(original: string, changed: string): string {
  const blocks = toBlocks(original, changed);
  const views = renderRowViews(blocks);

  let removedCount = 0;
  let addedCount = 0;
  for (const block of blocks) {
    if (block.kind === "change") {
      removedCount += block.removed.length;
      addedCount += block.added.length;
    }
  }

  const splitHeader = `<div class="row split header"><span>Original</span><span>Changed</span></div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Diff (−${removedCount} +${addedCount})</title>
<style>${STYLES}</style>
</head>
<body data-layout="split">
<header>
  <div class="stats"><span class="stat-del">−${removedCount}</span> <span class="stat-ins">+${addedCount}</span></div>
  <div class="controls">
    <div class="segmented">
      <button data-set="layout" data-value="split" title="Split view" aria-label="Split view">
        <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
          <path d="M8 2.5v11" />
        </svg>
      </button>
      <button data-set="layout" data-value="inline" title="Unified view" aria-label="Unified view">
        <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
          <path d="M5.5 6h5M5.5 10h5" stroke-linecap="round" />
        </svg>
      </button>
    </div>
  </div>
</header>
<main>
  <section class="view" id="inline"><div class="grid">${views.unified}</div></section>
  <section class="view" id="split"><div class="grid">${splitHeader}${views.split}</div></section>
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}

const SCRIPT = `
const body = document.body;
const buttons = document.querySelectorAll("button[data-set]");
function sync() {
  buttons.forEach((b) => b.setAttribute("aria-pressed", String(body.dataset[b.dataset.set] === b.dataset.value)));
}
buttons.forEach((b) => b.addEventListener("click", () => { body.dataset[b.dataset.set] = b.dataset.value; sync(); }));
sync();
`;

const STYLES = `
:root {
  --bg: #fff; --fg: #222; --muted: #737373; --border: #e5e5e5; --subtle: rgba(0, 0, 0, 0.04); --stripe: #eeeeee;
  --header-bg: rgba(255, 255, 255, 0.82);
  --active-bg: rgba(0, 0, 0, 0.07); --active-fg: #111;
  --del-line: #fdecec; --del-word: #f6b8b8; --del-fg: #c62828;
  --ins-line: #e9f7ec; --ins-word: #a8e0b4; --ins-fg: #2e7d32;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141414; --fg: #e6e6e6; --muted: #888; --border: #262626; --subtle: rgba(255, 255, 255, 0.05); --stripe: #222;
    --header-bg: rgba(20, 20, 20, 0.82);
    --active-bg: rgba(255, 255, 255, 0.1); --active-fg: #ffffff;
    --del-line: rgba(229, 83, 75, 0.14); --del-word: rgba(229, 83, 75, 0.42); --del-fg: #f07167;
    --ins-line: rgba(74, 180, 96, 0.14); --ins-word: rgba(74, 180, 96, 0.42); --ins-fg: #6cc57c;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 13px/20px "SF Mono", SFMono-Regular, ui-monospace, Menlo, Consolas, monospace;
}
header {
  position: sticky; top: 0; z-index: 10; display: flex; align-items: center; justify-content: space-between;
  padding: 8px 16px; background: var(--header-bg); border-bottom: 1px solid var(--border);
  backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}
.stats {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 12px; font-weight: 600;
}
.stat-del, .stat-ins {
  display: inline-flex; align-items: center;
  padding: 2px 7px; border-radius: 4px;
  font-variant-numeric: tabular-nums;
  line-height: 16px;
}
.stat-del { color: var(--del-fg); background: var(--del-line); }
.stat-ins { color: var(--ins-fg); background: var(--ins-line); }
.controls { display: flex; align-items: center; gap: 6px; }
.icon {
  width: 14px; height: 14px; display: block; opacity: 0.75;
  transition: opacity 0.12s ease;
}
.segmented {
  display: inline-flex; align-items: center; gap: 2px;
}
.segmented button {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; padding: 0; border: 0; border-radius: 5px;
  background: transparent; color: var(--muted); cursor: pointer;
  transition: color 0.12s ease, background 0.12s ease;
  user-select: none;
}
.segmented button:hover:not([aria-pressed="true"]) { background: var(--subtle); color: var(--fg); }
.segmented button:hover:not([aria-pressed="true"]) .icon { opacity: 0.95; }
.segmented button:focus { outline: none; }
.segmented button:focus-visible { outline: 2px solid var(--muted); outline-offset: 1px; }
.segmented button[aria-pressed="true"] {
  background: var(--active-bg); color: var(--active-fg);
}
.segmented button[aria-pressed="true"] .icon { opacity: 1; }
.view { display: none; }
body[data-layout="inline"] #inline,
body[data-layout="split"] #split { display: block; }
.row { display: grid; }
.row.split { grid-template-columns: 3em minmax(0, 1fr) 3em minmax(0, 1fr); }
.row.unified { grid-template-columns: 3em 3em 1.5em minmax(0, 1fr); }
.row.header { border-bottom: 1px solid var(--border); color: var(--muted); font-size: 12px; }
.row.header span { grid-column: span 2; padding: 4px 10px; }
.row.header span + span { border-left: 1px solid var(--border); }
.no { padding: 0 8px; text-align: right; color: var(--muted); user-select: none; font-size: 12px; }
.row.split .no:nth-child(3) { border-left: 1px solid var(--border); }
.sign { text-align: center; color: var(--muted); user-select: none; }
.code { padding: 0 10px; white-space: pre-wrap; overflow-wrap: anywhere; min-height: 20px; }
.l-del { background: var(--del-line); }
.l-ins { background: var(--ins-line); }
.empty { background: repeating-linear-gradient(-45deg, var(--stripe), var(--stripe) 4px, transparent 4px, transparent 8px); }
.w-del { background: var(--del-word); }
.w-ins { background: var(--ins-word); }
.l-mod { background: var(--subtle); }
.l-mod .w-del { text-decoration: line-through; text-decoration-color: var(--del-fg); }
.l-mod .w-del + .w-ins { margin-left: 2px; }
.brk::after { content: "↵"; padding: 0 2px; user-select: none; }
.fold > summary {
  list-style: none; cursor: pointer; padding: 0 12px; background: var(--subtle); color: var(--muted);
  font-size: 12px; user-select: none;
}
.fold > summary::-webkit-details-marker { display: none; }
.fold[open] > summary { display: none; }
`;
