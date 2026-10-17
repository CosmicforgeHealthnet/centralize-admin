// Convert only catch clauses that consume the error through an Axios-style
// response?.data?.message chain, a preexisting message normalizer, or rethrow.
// This is a typed, runtime-guarded refactor, not a lint-rule suppression.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
const root = path.resolve(import.meta.dirname, "..", "src");
let count = 0;
let changedFiles = 0;

function processFile(filepath) {
  const input = fs.readFileSync(filepath, "utf8");
  const ast = ts.createSourceFile(filepath, input, ts.ScriptTarget.Latest, true,
    filepath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const replacements = [];
  function visit(node) {
    if (ts.isCatchClause(node) && node.variableDeclaration?.type?.kind === ts.SyntaxKind.AnyKeyword &&
        ts.isIdentifier(node.variableDeclaration.name)) {
      const name = node.variableDeclaration.name.text;
      const messageRegex = new RegExp("^" + name + "\\.response\\?\\.data\\?\\.message$");
      const expressions = [];
      let safe = true;
      function inspect(inner) {
        if (ts.isPropertyAccessExpression(inner) && messageRegex.test(inner.getText(ast))) {
          expressions.push(inner);
          return;
        }
        if (ts.isIdentifier(inner) && inner.text === name) {
          const parent = inner.parent;
          const forwarded = ts.isCallExpression(parent) &&
            parent.arguments.some(arg => arg === inner) &&
            ts.isIdentifier(parent.expression) &&
            /^(extract|resolve|format|parse|normalize|get)[A-Za-z]*ErrorMessage$/.test(parent.expression.text);
          const rethrown = ts.isThrowStatement(parent) && parent.expression === inner;
          if (!forwarded && !rethrown) safe = false;
        }
        ts.forEachChild(inner, inspect);
      }
      inspect(node.block);
      if (safe && expressions.length) {
        for (const exp of expressions)
          replacements.push({ start: exp.getStart(ast), end: exp.end,
            after: "readHttpErrorMessage(" + name + ")" });
        const type = node.variableDeclaration.type;
        replacements.push({ start: type.getStart(ast), end: type.end, after: "unknown" });
        count++;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (!replacements.length) return;
  if (!input.includes('from "@/lib/error-messages"')) {
    const imports = ast.statements.filter(ts.isImportDeclaration);
    const pos = imports.length ? imports[imports.length-1].end : 0;
    replacements.push({ start: pos, end: pos,
      after: (pos === 0 ? "" : "\n") + 'import { readHttpErrorMessage } from "@/lib/error-messages";\n' });
  }
  let output = input;
  for(const change of replacements.sort((a,b)=>b.start-a.start))
    output = output.slice(0,change.start)+change.after+output.slice(change.end);
  // Remove existing whitespace-only lines in touched files to keep git diff --check clean.
  fs.writeFileSync(filepath, output.replace(/^[ \\t]+$/gm, ""));
  changedFiles++;
}
function walk(dir) {
  for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
    const p = path.join(dir,entry.name);
    if(entry.isDirectory()) walk(p);
    else if(entry.isFile() && /\.tsx?$/.test(p))processFile(p);
  }
}
walk(root);
console.log(`Safely typed ${count} HTTP error catch clauses across ${changedFiles} files`);
