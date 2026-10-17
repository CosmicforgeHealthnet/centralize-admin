// Converts catch (err: any) to catch (err: unknown) only where uses
// are already type-safe forwarding to an error message helper or throw.
// Does not rewrite exception behavior or silence lint rules.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const project = path.resolve(import.meta.dirname, "..", "src");
let changed = 0;
let filesChanged = 0;

function processFile(filepath) {
  const source = fs.readFileSync(filepath, "utf8");
  const parsed = ts.createSourceFile(filepath, source, ts.ScriptTarget.Latest, true,
    filepath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const replacements = [];
  function visit(node) {
    if (ts.isCatchClause(node) && node.variableDeclaration?.type?.kind === ts.SyntaxKind.AnyKeyword) {
      const parameter = node.variableDeclaration.name;
      if (ts.isIdentifier(parameter)) {
        const name = parameter.text;
        let safe = true;
        function inspect(inner) {
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
        if (safe) {
          const type = node.variableDeclaration.type;
          replacements.push({ start: type.getStart(parsed), end: type.end });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  if (!replacements.length) return;
  let output = source;
  for (const {start, end} of replacements.sort((a,b)=>b.start-a.start))
    output = output.slice(0, start) + "unknown" + output.slice(end);
  fs.writeFileSync(filepath, output);
  filesChanged++;
  changed += replacements.length;
}
function walk(dir) {
  for(const e of fs.readdirSync(dir,{withFileTypes:true})){
    const p=path.join(dir,e.name);
    if(e.isDirectory())walk(p);
    else if(e.isFile() && /\.tsx?$/.test(p))processFile(p);
  }
}
walk(project);
console.log(`Safely typed ${changed} catch clauses across ${filesChanged} files`);
