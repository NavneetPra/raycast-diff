import { writeFileSync } from "node:fs";
import { normalizeText, renderDiffHtml } from "../src/diff-html.ts";

const unchanged = Array.from({ length: 20 }, (_, i) => `Unchanged filler line number ${i + 1}.`).join("\n");

const original = normalizeText(`The quick brown fox jumps over the lazy dog.
This line stays exactly the same.
Raycast extensions are written in TypeScript & React <with JSX>.
This line will be removed entirely.
${unchanged}
function add(a, b) {
  return a + b;
}
Final paragraph: the meeting is on Tuesday at 3pm in room 4.`);

const changed = normalizeText(`The quick red fox leaps over the lazy dog.
This line stays exactly the same.
Raycast extensions are written in TypeScript and React <with JSX>.
${unchanged}
function add(a, b, c) {
  return a + b + c;
}
A brand new line was added here.
Final paragraph: the meeting is on Wednesday at 4pm in room 4.`);

writeFileSync("preview/index.html", renderDiffHtml(original, changed));
console.log("wrote preview/index.html");
