const { execFileSync, execSync } = require("child_process");

function npmBin() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

try {
  const output = process.platform === "win32"
    ? execSync(`${npmBin()} sbom --json`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
    : execFileSync(npmBin(), ["sbom", "--json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
  process.stdout.write(output);
} catch (error) {
  const message = String(error.stderr || error.message || "npm sbom unavailable")
    .split(/\r?\n/)
    .filter(Boolean)[0];
  console.log(`sbom status=unsupported reason=${message}`);
}
