// Custom node:test reporter: one JSON line per finished test with the test
// file, so required-suite checks can attribute skips to files (TAP and spec
// output do not carry the file). Used by product-admin-no-required-skips.mjs.
//
//   node --test --test-reporter=spec --test-reporter-destination=stdout \
//     --test-reporter=./infrastructure/scripts/node-test-jsonl-reporter.mjs \
//     --test-reporter-destination=out.jsonl tests/*.test.js

export default async function* jsonlReporter(source) {
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const d = event.data || {};
    const err = d.details && d.details.error;
    yield JSON.stringify({
      type: event.type,
      name: d.name,
      file: d.file || null,
      nesting: d.nesting,
      skip: d.skip === undefined || d.skip === false ? false : (typeof d.skip === "string" ? d.skip : true),
      todo: d.todo === undefined || d.todo === false ? false : (typeof d.todo === "string" ? d.todo : true),
      failure_type: err && err.failureType ? err.failureType : null,
      duration_ms: d.details ? d.details.duration_ms : null,
    }) + "\n";
  }
}
