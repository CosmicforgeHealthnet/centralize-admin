// CI-only recording backend behind the test Nginx. Port 9000 answers every
// proxied request with 200 and records what actually arrived; port 9001
// (never proxied) returns and clears the record for the probe.
import http from "node:http";

let seen = [];

http.createServer((req, res) => {
  seen.push({ method: req.method, url: req.url, host: req.headers.host || null, x_forwarded_host: req.headers["x-forwarded-host"] || null, x_original_url: req.headers["x-original-url"] || null });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ backend: true }));
}).listen(9000, "0.0.0.0");

http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(seen));
  seen = [];
}).listen(9001, "0.0.0.0", () => process.stdout.write("backend-stub ready\n"));
