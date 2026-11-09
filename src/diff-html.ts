import { diffLines, diffWordsWithSpace } from "diff";

type Block = { kind: "equal"; lines: string[] } | { kind: "change"; removed: string[]; added: string[] };

interface WordDiff {
  left: string;
  right: string;
  inline: string;
}

interface Side {
  no: number;
  html: string;
  cls: string;
}

const CONTEXT_LINES = 3;
const MIN_FOLDED_LINES = 4;
const WORD_DIFF_TIMEOUT_MS = 2000;
const MIN_PAIR_SIMILARITY = 0.4;
const MAX_ALIGN_CELLS = 2500;

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

function mark(text: string, className: string): string {
  return text ? `<span class="${className}">${escapeHtml(text)}</span>` : "";
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

function wordDiff(original: string, changed: string): WordDiff {
  const changes = diffWordsWithSpace(original, changed, { timeout: WORD_DIFF_TIMEOUT_MS });
  if (!changes) {
    const left = mark(original, "w-del");
    const right = mark(changed, "w-ins");
    return { left, right, inline: left + right };
  }

  let left = "";
  let right = "";
  let inline = "";
  for (const change of changes) {
    if (change.removed) {
      const html = mark(change.value, "w-del");
      left += html;
      inline += html;
    } else if (change.added) {
      const html = mark(change.value, "w-ins");
      right += html;
      inline += html;
    } else {
      const html = escapeHtml(change.value);
      left += html;
      right += html;
      inline += html;
    }
  }
  return { left, right, inline };
}

function similarity(a: string, b: string): number {
  if (!a && !b) return 1;
  const changes = diffWordsWithSpace(a, b, { maxEditLength: 200 });
  if (!changes) return 0;
  const common = changes.reduce((sum, c) => (c.added || c.removed ? sum : sum + c.value.trim().length), 0);
  return (2 * common) / (a.trim().length + b.trim().length || 1);
}

/** Pairs similar removed/added lines in order; unpaired lines get `undefined` on the other side. */
function alignLines(removed: string[], added: string[]): [number | undefined, number | undefined][] {
  const n = removed.length;
  const m = added.length;
  if (n === 0 || m === 0 || n * m > MAX_ALIGN_CELLS) {
    return Array.from({ length: Math.max(n, m) }, (_, i) => [i < n ? i : undefined, i < m ? i : undefined]);
  }

  const score = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const sim = removed.map((a) => added.map((b) => similarity(a, b)));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const pair = sim[i][j] >= MIN_PAIR_SIMILARITY ? sim[i][j] + score[i + 1][j + 1] : -1;
      score[i][j] = Math.max(pair, score[i + 1][j], score[i][j + 1]);
    }
  }

  const result: [number | undefined, number | undefined][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (sim[i][j] >= MIN_PAIR_SIMILARITY && score[i][j] === sim[i][j] + score[i + 1][j + 1]) result.push([i++, j++]);
    else if (score[i][j] === score[i + 1][j]) result.push([i++, undefined]);
    else result.push([undefined, j++]);
  }
  while (i < n) result.push([i++, undefined]);
  while (j < m) result.push([undefined, j++]);
  return result;
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
 * Line views shade whole changed rows and highlight changed words inside paired lines.
 * The word split view only highlights the changed words themselves.
 */
function renderRowViews(blocks: Block[]) {
  let oldNo = 1;
  let newNo = 1;
  let lineSplit = "";
  let lineUnified = "";
  let wordSplit = "";
  let wordUnified = "";

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
      const splitHtml = foldEqual(splitRows, isFirst, isLast);
      lineSplit += splitHtml;
      wordSplit += splitHtml;
      const unifiedHtml = foldEqual(unifiedRows, isFirst, isLast);
      lineUnified += unifiedHtml;
      wordUnified += unifiedHtml;
      return;
    }

    const { removed, added } = block;
    const lineLeft = removed.map(escapeHtml);
    const lineRight = added.map(escapeHtml);
    const wordLeft = removed.map((line) => mark(line, "w-del"));
    const wordRight = added.map((line) => mark(line, "w-ins"));
    const wordInline = new Map<number, string>();
    const pairs = alignLines(removed, added);
    for (const [ri, ai] of pairs) {
      if (ri === undefined || ai === undefined) continue;
      const diff = wordDiff(removed[ri], added[ai]);
      lineLeft[ri] = wordLeft[ri] = diff.left;
      lineRight[ai] = wordRight[ai] = diff.right;
      wordInline.set(ri, diff.inline);
    }

    for (const [ri, ai] of pairs) {
      const side = (i: number | undefined, start: number, html: string[], cls: string) =>
        i === undefined ? undefined : { no: start + i, html: html[i], cls };
      lineSplit += splitRow(side(ri, oldNo, lineLeft, "l-del"), side(ai, newNo, lineRight, "l-ins"));
      wordSplit += splitRow(side(ri, oldNo, wordLeft, ""), side(ai, newNo, wordRight, ""));

      if (ri !== undefined && ai !== undefined) {
        wordUnified += unifiedRow(oldNo + ri, newNo + ai, "", wordInline.get(ri) ?? "", "");
      } else if (ri !== undefined) {
        wordUnified += unifiedRow(oldNo + ri, "", "−", wordLeft[ri], "");
      } else if (ai !== undefined) {
        wordUnified += unifiedRow("", newNo + ai, "+", wordRight[ai], "");
      }
    }

    removed.forEach((_, i) => (lineUnified += unifiedRow(oldNo + i, "", "−", lineLeft[i], "l-del")));
    added.forEach((_, i) => (lineUnified += unifiedRow("", newNo + i, "+", lineRight[i], "l-ins")));

    oldNo += removed.length;
    newNo += added.length;
  });

  return { lineSplit, lineUnified, wordSplit, wordUnified };
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
<body data-granularity="line" data-layout="inline">
<header>
  <div class="stats"><span class="stat-del">−${removedCount}</span> <span class="stat-ins">+${addedCount}</span></div>
  <div class="controls">
    <div class="segmented">
      <button data-set="granularity" data-value="line" title="Line diff" aria-label="Line diff">
        <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke-linecap="round" />
        </svg>
      </button>
      <button data-set="granularity" data-value="word" title="Word diff" aria-label="Word diff">
        <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M2.5 4.5h4M8.5 4.5h5M2.5 8h5M9.5 8h4M2.5 11.5h3.5M8 11.5h5.5" stroke-linecap="round" />
        </svg>
      </button>
    </div>
    <div class="divider"></div>
    <div class="segmented">
      <button data-set="layout" data-value="inline" title="Unified view" aria-label="Unified view">
        <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
          <path d="M5.5 6h5M5.5 10h5" stroke-linecap="round" />
        </svg>
      </button>
      <button data-set="layout" data-value="split" title="Split view" aria-label="Split view">
        <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
          <path d="M8 2.5v11" />
        </svg>
      </button>
    </div>
  </div>
</header>
<main>
  <section class="view" id="line-inline"><div class="grid">${views.lineUnified}</div></section>
  <section class="view" id="line-split"><div class="grid">${splitHeader}${views.lineSplit}</div></section>
  <section class="view" id="word-inline"><div class="grid">${views.wordUnified}</div></section>
  <section class="view" id="word-split"><div class="grid">${splitHeader}${views.wordSplit}</div></section>
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
.divider { width: 1px; height: 14px; background: var(--border); margin: 0 2px; }
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
body[data-granularity="line"][data-layout="inline"] #line-inline,
body[data-granularity="line"][data-layout="split"] #line-split,
body[data-granularity="word"][data-layout="inline"] #word-inline,
body[data-granularity="word"][data-layout="split"] #word-split { display: block; }
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
#word-inline .w-del { text-decoration: line-through; text-decoration-color: var(--del-fg); }
.fold > summary {
  list-style: none; cursor: pointer; padding: 0 12px; background: var(--subtle); color: var(--muted);
  font-size: 12px; user-select: none;
}
.fold > summary::-webkit-details-marker { display: none; }
.fold[open] > summary { display: none; }
`;
