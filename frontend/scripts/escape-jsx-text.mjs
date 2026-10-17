// One-time, behavior-preserving React JSX text cleanup.
// Changes unescaped apostrophes/quotation marks in JSX *text nodes only*.
// JSX attributes, strings, scripts, expressions, and TypeScript code are untouched.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const project = path.resolve(import.meta.dirname, "..");
const directory = path.join(project, "src");
let changedFiles = 0;
let changedTextNodes = 0;

function visitFile(filepath) {
  const source = fs.readFileSync(filepath, "utf8");
  const parsed = ts.createSourceFile(filepath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = [];
  function visit(node) {
    if (ts.isJsxText(node)) {
      const before = source.slice(node.pos, node.end);
      const after = before.replace(/'/g, "&apos;").replace(/"/g, "&quot;");
      if (before !== after) edits.push({ start: node.pos, end: node.end, after });
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  if (!edits.length) return;
  let output = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    output = output.slice(0, edit.start) + edit.after + output.slice(edit.end);
  }
  fs.writeFileSync(filepath, output);
  changedFiles += 1;
  changedTextNodes += edits.length;
}
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filepath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(filepath);
    else if (entry.isFile() && filepath.endsWith(".tsx")) visitFile(filepath);
  }
}
walk(directory);
console.log(`Escaped JSX text nodes: ${changedTextNodes} in ${changedFiles} files`);
