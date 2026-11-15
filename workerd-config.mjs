// What the runtime's workerd builds share: bundling a Worker as wrangler does,
// and the workerd config of a Worker with site databases in it, which naru-dev
// runs as its one local process (dev/scripts/build-worker.mjs, src/dev.ts)
// and Naru runs on its own servers, as each shard. They differ only in their
// bindings, where the SDK's files and site databases are, and the name
// objects' ids derive from.
import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** This repository's root. */
export const runtime = dirname(fileURLToPath(import.meta.url));

/**
 * Bundles the Worker `config` (a wrangler file in `cwd`, by default this
 * folder) into `outdir`, with the wrangler installed there.
 */
export const bundleWorker = (config, outdir, cwd = runtime) =>
  execFileSync(
    join(cwd, "node_modules/.bin/wrangler"),
    ["deploy", "--dry-run", "--config", config, "--outdir", outdir],
    { cwd, stdio: "inherit" },
  );

const kind = (file) =>
  file.endsWith(".wasm")
    ? "wasm"
    : file.endsWith(".js") || file.endsWith(".mjs")
      ? "esModule"
      : null;

/**
 * The modules of the bundle in `dir`, as config lines that embed each from
 * `prefix` (the bundle's path from the config). The entry first: workerd
 * takes the first module as the Worker's main.
 */
export async function modulesOf(dir, entry, prefix) {
  const files = (await readdir(dir)).filter(
    (file) => !file.endsWith(".map") && file !== "README.md",
  );
  return [entry, ...files.filter((file) => file !== entry)]
    .filter((file) => kind(file))
    .map(
      (file) =>
        `      (name = "${file}", ${kind(file)} = embed "${prefix}${file}"),`,
    );
}

/** A binding of `name` to the environment variable `variable`. */
export const fromEnvironment = (name, variable = name) =>
  `      (name = "${name}", fromEnvironment = "${variable}"),`;

/**
 * The config of the Worker with site databases in it: `modules` (modulesOf),
 * `bindings` (config lines) after the ones every such Worker has, the SDK's
 * files and the site databases at `sdkFiles` and `siteObjects` (paths, or
 * null to be given with --directory-path), and objects' ids derived from
 * `uniqueKey`.
 */
export function siteDataConfig({
  header,
  modules,
  bindings,
  sdkFiles,
  siteObjects,
  uniqueKey,
}) {
  const disk = (path, writable) =>
    `(${[
      ...(path === null ? [] : [`path = "${path}"`]),
      ...(writable ? ["writable = true"] : []),
    ].join(", ")})`;
  return `${header}
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .worker),
    # The SDK's committed files (sdk/files), at /sdk/.
    (name = "sdk-files", disk = ${disk(sdkFiles, false)}),
    # Each site's SQLite database. Override with --directory-path.
    (name = "site-objects", disk = ${disk(siteObjects, true)}),
    # R2 is public; the control plane, for requests with a token, is local.
    (name = "network", network = (allow = ["public", "local"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:8787", http = (), service = "main"),
  ],
  # The most V8 keeps for JavaScript objects (MB), in the one isolate every
  # site's object and the Worker share: past it V8 aborts workerd, and
  # whatever supervises it starts it again. ArrayBuffers and SQLite are not
  # counted.
  v8Flags = ["--max-old-space-size=2048"],
);

const worker :Workerd.Worker = (
  compatibilityDate = "2026-10-01",
  compatibilityFlags = ["nodejs_compat"],
  modules = [
${modules.join("\n")}
  ],
  bindings = [
    (name = "SITES", durableObjectNamespace = "SiteData"),
    (name = "SDK_FILES", service = "sdk-files"),
    (name = "PLATFORM_DOMAIN", text = "naru.pub"),
    (name = "SITE_MONTHLY_REQUESTS", text = "5000000"),
    # No edge cache here: each visitor's read is a local SQLite query.
    (name = "EDGE_CACHE", text = "off"),
${bindings.join("\n")}
  ],
  durableObjectNamespaces = [
    (className = "SiteData", uniqueKey = "${uniqueKey}", enableSql = true),
  ],
  durableObjectStorage = (localDisk = "site-objects"),
  globalOutbound = "network",
);
`;
}
