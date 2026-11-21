// The package as a project gets it: its entry points resolve, the module
// imports in Node and its declaration files are there.
//
//   node test/smoke.mjs     wherever @naru-pub/sdk is installed (CI copies
//                           test/ beside an installed tarball)
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const manifest = require.resolve("@naru-pub/sdk/package.json");
const { version, exports } = JSON.parse(await readFile(manifest, "utf8"));
const root = dirname(manifest);

const sdk = await import("@naru-pub/sdk");
assert.equal(typeof sdk.createNaru, "function");
assert.equal(typeof sdk.NaruError, "function");
assert.throws(() => sdk.createNaru(), TypeError, "no site outside a page");
assert.equal(typeof sdk.createNaru({ site: "demo" }).query, "function");

// The builder handoff, from 1.2.0.
if (exports["./handoff"]) {
  const handoff = await import("@naru-pub/sdk/handoff");
  assert.equal(typeof handoff.propose, "function");
  assert.equal(typeof handoff.photo, "function");
  await assert.rejects(handoff.propose({ files: [] }), TypeError);
}

for (const types of [
  exports["."].types,
  exports["./functions"].types,
  exports["./handoff"]?.types,
].filter(Boolean)) {
  const text = await readFile(join(root, types), "utf8");
  assert.match(text, /@packageDocumentation/, types);
}

console.log(`@naru-pub/sdk ${version}: ok`);
