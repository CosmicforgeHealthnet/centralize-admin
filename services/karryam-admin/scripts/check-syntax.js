"use strict";

// Syntax-checks every JavaScript file of the service (node --check) and
// confirms the module graph loads, without starting the server.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

const files = [...walk(path.join(root, "src")), ...walk(path.join(root, "scripts"))];
for (const file of files) execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
require(path.join(root, "src/server/app.js"));
require(path.join(root, "src/server/index.js"));
console.log("syntax ok: " + files.length + " files");
