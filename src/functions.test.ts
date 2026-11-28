import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { bundleWorker, modulesOf, runtime } from "../workerd-config.mjs";
import type { HarnessCall } from "./functions.harness";

// Site code as the site's object runs it (functions.ts): functions.harness.ts
// bundled by wrangler and served by workerd, npm's or, with NARU_WORKERD_BIN,
// Naru's own with its CPU and heap limits (NARU_DYNAMIC_CPU_MS 50,
// NARU_DYNAMIC_HEAP_MB 64), which only it enforces.

const naru = process.env.NARU_WORKERD_BIN;
// functions.ts's limits (it imports cloudflare:workers, which Node has not).
const CALL_TIME_MS = 2000;
const MAX_OPERATIONS = 100;
const MAX_PASSWORD_OPERATIONS = 3;
let dir: string;
let worker: ChildProcess;
let origin: string;

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "naru-functions-"));
  await writeFile(
    join(dir, "wrangler.jsonc"),
    JSON.stringify({
      name: "naru-functions-harness",
      main: join(runtime, "src/functions.harness.ts"),
      compatibility_date: "2026-10-01",
      durable_objects: { bindings: [{ name: "HARNESS", class_name: "Harness" }] },
      exports: { Harness: { type: "durable-object", storage: "sqlite" } },
      worker_loaders: [{ binding: "LOADER" }],
    }),
  );
  bundleWorker(join(dir, "wrangler.jsonc"), join(dir, "dist"));
  const modules = await modulesOf(
    join(dir, "dist"),
    "functions.harness.js",
    "dist/",
  );
  await writeFile(
    join(dir, "config.capnp"),
    `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "main", worker = .worker),
    (name = "objects", disk = (path = "objects", writable = true)),
  ],
  sockets = [(name = "http", address = "127.0.0.1:8787", http = (), service = "main")],
);
const worker :Workerd.Worker = (
  compatibilityDate = "2026-10-01",
  modules = [
${modules.join("\n")}
  ],
  bindings = [
    (name = "HARNESS", durableObjectNamespace = "Harness"),
    (name = "LOADER", workerLoader = (id = "sites")),
  ],
  durableObjectNamespaces = [(className = "Harness", uniqueKey = "harness", enableSql = true)],
  durableObjectStorage = (localDisk = "objects"),
);
`,
  );
  await mkdir(join(dir, "objects"));
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  worker = spawn(
    naru ?? join(runtime, "node_modules/.bin/workerd"),
    [
      "serve",
      "--experimental",
      "config.capnp",
      "--socket-addr",
      `http=127.0.0.1:${port}`,
    ],
    {
      cwd: dir,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        NARU_DYNAMIC_CPU_MS: "50",
        NARU_DYNAMIC_HEAP_MB: "64",
      },
    },
  );
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${origin}/wallets`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("workerd did not start.");
}, 120_000);

afterAll(async () => {
  worker?.kill("SIGKILL");
  if (dir) await rm(dir, { recursive: true, force: true });
});

type Result =
  | { ok: true; result: unknown; operations: string[] }
  | {
      ok: false;
      status?: number;
      message?: string;
      code?: string;
      details?: unknown;
      site?: boolean;
      thrown?: string;
      operations: string[];
    };

let objects = 0;
/** A fresh object (scratch table) for each test that writes. */
const fresh = () => `o${++objects}`;

async function call(
  source: string,
  name: string,
  options: Partial<HarnessCall> & { object?: string } = {},
): Promise<Result> {
  const { object = "shared", ...rest } = options;
  const kind = rest.kind ?? "mutation";
  const entry =
    rest.entry ??
    (kind === "route"
      ? "routes.js"
      : `${kind === "query" ? "queries" : "mutations"}/test.js`);
  const response = await fetch(`${origin}/?object=${object}`, {
    method: "POST",
    body: JSON.stringify({
      modules: rest.modules ?? { [entry]: source },
      entry,
      name,
      ...rest,
    }),
  });
  return response.json() as Promise<Result>;
}
const wallets = async (object: string) =>
  (await fetch(`${origin}/wallets?object=${object}`)).json();

describe("calling", () => {
  test("site code gets ctx and its arguments, and returns JSON", async () => {
    expect(
      await call(
        `export async function f(ctx, args) {
          return { member: ctx.member, owner: ctx.owner, now: ctx.now, ownerName: ctx.ownerName, args };
        }`,
        "f",
        { args: { a: [1, "two"] } },
      ),
    ).toMatchObject({
      ok: true,
      result: {
        member: { id: "m-1" },
        owner: false,
        now: 1_700_000_000_000,
        ownerName: "jihyeok",
        args: { a: [1, "two"] },
      },
    });
  });

  test("a query's, a route's and a mutation's ctx hold what each may do", async () => {
    const keys = "export function f(ctx) { return Object.keys(ctx); }";
    for (const kind of ["query", "route"] as const)
      expect(await call(keys, "f", { kind })).toMatchObject({
        result: ["member", "owner", "ownerName", "now", "fail", "sql", "passwords"],
      });
    expect(await call(keys, "f")).toMatchObject({
      result: ["member", "owner", "ownerName", "now", "fail", "sql", "passwords", "notify"],
    });
    expect(
      await call("export function f(ctx) { return Object.keys(ctx.passwords); }", "f", {
        kind: "query",
      }),
    ).toMatchObject({ result: ["verify"] });
  });

  test("the owner, a member and a visitor are told apart", async () => {
    const who = "export function f(ctx) { return [ctx.member, ctx.owner]; }";
    expect(await call(who, "f", { member: null, owner: true })).toMatchObject({
      result: [null, true],
    });
    expect(await call(who, "f", { member: null })).toMatchObject({
      result: [null, false],
    });
  });

  test("undefined is null, no arguments are undefined, and only own exports are functions", async () => {
    expect(await call("export function f() {}", "f")).toMatchObject({ result: null });
    expect(
      await call("export function f(ctx, { board } = { board: 'free' }) { return board; }", "f"),
    ).toMatchObject({ result: "free" });
    for (const name of ["value", "toString", "constructor", "nope"])
      expect(await call("export const value = 1;", name)).toMatchObject({
        ok: false,
        status: 404,
      });
  });

  test("ctx.fail carries the site's code, message and details to the caller", async () => {
    expect(
      await call(
        "export function f(ctx) { ctx.fail('CONFLICT', 'Sold out.', { left: 0 }); }",
        "f",
      ),
    ).toMatchObject({
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: "Sold out.",
      details: { left: 0 },
      site: true,
    });
    // Caught, it still fails the call.
    expect(
      await call(
        "export function f(ctx) { try { ctx.fail('NOT_FOUND', 'No such post.'); } catch {} return 1; }",
        "f",
      ),
    ).toMatchObject({ ok: false, status: 404, message: "No such post." });
    expect(
      await call("export function f(ctx) { ctx.fail('NOPE', 'x'); }", "f"),
    ).toMatchObject({ ok: false, status: 400, message: /v1 error code/ });
  });

  test("code that throws is Naru's 400, which says what it threw", async () => {
    expect(
      await call("export function f() { throw new TypeError('sold out'); }", "f"),
    ).toMatchObject({
      ok: false,
      status: 400,
      message: "Function failed: TypeError: sold out",
    });
  });

  test("a result over 1 MiB is refused", async () => {
    expect(
      await call("export function f() { return 'x'.repeat(1024 * 1024 + 1); }", "f"),
    ).toMatchObject({ ok: false, message: /larger than 1 MiB/ });
  });

  test("a module that does not parse says so", async () => {
    expect(await call("export function f( {", "f")).toMatchObject({
      ok: false,
      status: 400,
      message: /does not load/,
    });
  });

  test("modules import each other, cycles and re-exports included", async () => {
    expect(
      await call("", "buy", {
        modules: {
          "mutations/shop/buy.js":
            "import { price } from '../../modules/prices.js'; export { tax } from '../../modules/tax.js'; export function buy() { return price; }",
          "modules/prices.js":
            "import { tax } from './tax.js'; export const price = 10 + tax;",
          "modules/tax.js":
            "import { price } from './prices.js'; export const tax = 1; export const later = () => price;",
        },
        entry: "mutations/shop/buy.js",
      }),
    ).toMatchObject({ result: 11 });
  });
});

describe("ctx", () => {
  test("sql runs in the call's transaction: a later failure rolls it back", async () => {
    const object = fresh();
    expect(
      await call(
        `export async function f(ctx) {
          await ctx.sql\`INSERT INTO wallets (id, balance) VALUES (\${"m-1"}, 100)\`;
          return (await ctx.sql("SELECT balance FROM wallets WHERE id = ?", ["m-1"])).rows;
        }`,
        "f",
        { object },
      ),
    ).toMatchObject({ result: [{ balance: 100 }] });
    expect(
      await call(
        `export async function f(ctx) {
          await ctx.sql("UPDATE wallets SET balance = 0");
          await null;
          throw new Error("after the write");
        }`,
        "f",
        { object },
      ),
    ).toMatchObject({ ok: false, status: 400 });
    expect(await wallets(object)).toEqual([{ id: "m-1", balance: 100 }]);
  });

  test("operations in Promise.all each answer, in order", async () => {
    expect(
      await call(
        `export async function f(ctx) {
          const answers = await Promise.all([1, 2, 3].map((n) => ctx.sql("SELECT ? AS n", [n])));
          return answers.map((answer) => answer.rows[0].n);
        }`,
        "f",
      ),
    ).toMatchObject({ result: [1, 2, 3] });
  });

  test("BLOBs are Uint8Arrays both ways", async () => {
    expect(
      await call(
        `export async function f(ctx) {
          await ctx.sql("INSERT INTO wallets (id, data) VALUES (?, ?)", ["b", new Uint8Array([0, 1, 255])]);
          const { rows } = await ctx.sql("SELECT data FROM wallets WHERE id = 'b'");
          return [rows[0].data instanceof Uint8Array, [...rows[0].data]];
        }`,
        "f",
        { object: fresh() },
      ),
    ).toMatchObject({ result: [true, [0, 1, 255]] });
  });

  test("a query's SQL only reads, whatever its code asks", async () => {
    expect(
      await call(
        "export function f(ctx) { return ctx.sql('DELETE FROM wallets'); }",
        "f",
        { kind: "query" },
      ),
    ).toMatchObject({ ok: false, message: "A query's SQL only reads." });
  });

  test("a failed operation fails the call with the host's error, even if caught", async () => {
    expect(
      await call(
        `export async function f(ctx) {
          try { await ctx.sql("SELECT * FROM nowhere"); } catch {}
          return 1;
        }`,
        "f",
      ),
    ).toMatchObject({ ok: false, status: 500 });
    expect(
      await call(
        "export async function f(ctx) { try { await ctx.sql('DELETE FROM wallets'); } catch {} return 1; }",
        "f",
        { kind: "query" },
      ),
    ).toMatchObject({ ok: false, message: "A query's SQL only reads." });
  });

  test("every operation's promise must be used", async () => {
    expect(
      await call("export function f(ctx) { ctx.sql('SELECT 1'); return 1; }", "f"),
    ).toMatchObject({ ok: false, message: "Function failed: it did not await ctx.sql." });
    expect(
      await call(
        "export async function f(ctx) { if (!ctx.passwords.verify('a', 'hash:a', 'k')) return 'never'; return 'always'; }",
        "f",
      ),
    ).toMatchObject({ ok: false, message: /did not await ctx.passwordVerify/ });
  });

  test(`a call makes at most ${MAX_OPERATIONS} operations and ${MAX_PASSWORD_OPERATIONS} password ones`, async () => {
    const flood = await call(
      "export async function f(ctx) { for (;;) await ctx.sql('SELECT 1'); }",
      "f",
    );
    expect(flood).toMatchObject({
      ok: false,
      message: `Function failed: more than ${MAX_OPERATIONS} database operations.`,
    });
    expect(flood.operations).toHaveLength(MAX_OPERATIONS);
    expect(
      await call(
        "export async function f(ctx) { for (;;) await ctx.passwords.hash('pw'); }",
        "f",
      ),
    ).toMatchObject({ message: /more than 3 password operations/ });
    expect(
      await call(
        "export async function f(ctx) { return [await ctx.passwords.hash('pw'), await ctx.passwords.verify('pw', 'hash:pw', 'k')]; }",
        "f",
      ),
    ).toMatchObject({ result: ["hash:pw", true] });
  });

  test("ctx is frozen", async () => {
    expect(
      await call(
        "export function f(ctx) { 'use strict'; ctx.sql = null; }",
        "f",
      ),
    ).toMatchObject({ ok: false, message: /TypeError/ });
  });
});

describe("the isolate", () => {
  test("has no network, no code from strings, and the platform's URL and structuredClone", async () => {
    expect(
      await call(
        `export async function f() {
          const out = {};
          try { await fetch("https://example.com"); out.fetch = "reached"; } catch (e) { out.fetch = "refused"; }
          try { eval("1"); out.eval = "ran"; } catch { out.eval = "refused"; }
          const url = new URL("/a?b=1", "https://naru.pub");
          out.url = [url.href, url.searchParams.get("b")];
          out.clone = structuredClone({ d: new Map([[1, 2]]) }).d.get(1);
          out.console = console.log("quiet") === undefined;
          return out;
        }`,
        "f",
      ),
    ).toMatchObject({
      result: {
        fetch: "refused",
        eval: "refused",
        url: ["https://naru.pub/a?b=1", "1"],
        clone: 2,
        console: true,
      },
    });
  });

  test("code awaiting what never settles fails, and so does a call past its time", async () => {
    expect(
      await call("export async function f() { await new Promise(() => {}); }", "f"),
    ).toMatchObject({ ok: false, status: 400 });
    const object = fresh();
    const late = await call(
      `export async function f(ctx) {
        await new Promise((resolve) => setTimeout(resolve, ${CALL_TIME_MS + 500}));
        await ctx.sql("INSERT INTO wallets (id, balance) VALUES ('late', 1)");
      }`,
      "f",
      { object },
    );
    expect(late).toMatchObject({ ok: false, message: "Function failed: it ran too long." });
    // Its ctx answers nothing once the call has ended.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(await wallets(object)).toEqual([]);
  });

  test.runIf(naru)("Naru's workerd stops code past its CPU or memory", async () => {
    const object = fresh();
    for (const [source, message] of [
      ["export function f() { for (;;) {} }", "it ran too long."],
      ["export async function f() { for (;;) await null; }", "it ran too long."],
      ["export function f() { return /(a+)+$/.test('a'.repeat(40) + 'b'); }", "it ran too long."],
      [
        "export async function f(ctx) { await ctx.sql(\"INSERT INTO wallets (id, balance) VALUES ('x', 1)\"); for (;;) {} }",
        "it ran too long.",
      ],
    ])
      expect(await call(source, "f", { object })).toMatchObject({
        ok: false,
        message: `Function failed: ${message}`,
      });
    expect(await wallets(object)).toEqual([]);
    expect(await call("export function f() { return 1; }", "f")).toMatchObject({
      result: 1,
    });
  });
});
