// A local Naru for one site, from this checkout:
//   pnpm start <site folder> [--site name] [--port 4000] [--state dir]
//
// The same naru-dev as the @naru-pub/dev package (README.md says what it
// emulates), run from source: the runtime is bundled into .worker/ first,
// and served with the runtime's workerd and this checkout's SDK files.
// Install the repository root first (pnpm install there).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
// @ts-expect-error: a plain module of the package's build, without types.
import { buildWorker } from "./build-worker.mjs";
import { main } from "../src/cli";

const repo = resolve(import.meta.dirname, "../..");
if (!existsSync(join(repo, "node_modules/.bin/wrangler"))) {
  console.error("Run pnpm install in the repository root first.");
  process.exit(1);
}
const workerDir = join(repo, "dev/.worker");
await buildWorker(workerDir);
const workerd = createRequire(join(repo, "package.json"))("workerd") as {
  default: string;
};
const { version } = JSON.parse(
  readFileSync(join(repo, "dev/package.json"), "utf8"),
);
let commit = "checkout";
try {
  commit = `${execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()} checkout`;
} catch {
  /* not a git checkout */
}
process.exit(
  await main(
    process.argv.slice(2),
    {
      workerDir,
      sdkDir: join(repo, "sdk/files"),
      workerd: workerd.default,
    },
    { version, commit },
  ),
);
