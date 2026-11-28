import { DurableObject } from "cloudflare:workers";
import { runFunction, workerCode, type Host, type Loader } from "./functions";
import { DataError } from "./site-data/validation";

// A Worker for functions.test.ts: an object that runs site code as the
// site's object does (site.ts `call`): the release in its own isolate,
// inside one transaction, with a host that runs its SQL on a scratch table
// and stands in for the rest.

type Env = { HARNESS: DurableObjectNamespace<Harness>; LOADER: Loader };

export type HarnessCall = {
  modules: Record<string, string>;
  entry?: string;
  name: string;
  args?: unknown;
  kind?: "query" | "mutation" | "route";
  member?: string | null;
  owner?: boolean;
};

const digest = async (text: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export class Harness extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS wallets (id TEXT PRIMARY KEY, balance INTEGER, data BLOB)",
    );
  }

  async call(input: HarnessCall) {
    const kind = input.kind ?? "mutation";
    const operations: string[] = [];
    const sql = this.ctx.storage.sql;
    const host: Host = (operation, args) => {
      operations.push(operation);
      switch (operation) {
        case "sql": {
          const [text, values, readonly] = args as [string, unknown[], boolean];
          if (readonly && !/^\s*SELECT/i.test(text))
            throw new DataError(400, "A query's SQL only reads.");
          const bound = (values ?? []).map((value) =>
            value && typeof value === "object" && "$blob" in value
              ? Uint8Array.from(atob((value as { $blob: string }).$blob), (c) =>
                  c.charCodeAt(0),
                )
              : value,
          );
          const cursor = sql.exec(text, ...(bound as SqlStorageValue[]));
          const rows = cursor.toArray().map((row) =>
            Object.fromEntries(
              Object.entries(row).map(([key, value]) => [
                key,
                value instanceof ArrayBuffer
                  ? {
                      $blob: btoa(String.fromCharCode(...new Uint8Array(value))),
                    }
                  : value,
              ]),
            ),
          );
          return { rows, changes: readonly ? 0 : cursor.rowsWritten };
        }
        case "passwordHash":
          return `hash:${args[0]}`;
        case "passwordVerify":
          return args[1] === `hash:${args[0]}`;
        case "notify":
          return null;
        default:
          throw new DataError(400, `ctx has no ${operation}.`);
      }
    };
    const entries = Object.keys(input.modules).filter(
      (file) =>
        /^(queries|mutations)\/.+\.m?js$/.test(file) ||
        /^routes\.m?js$/.test(file),
    );
    const code = this.env.LOADER.get(
      `release:${await digest(JSON.stringify(input.modules))}`,
      async () => workerCode(input.modules, entries),
    ).getEntrypoint();
    await this.ctx.storage.sync();
    try {
      const result = await this.ctx.storage.transaction(() =>
        runFunction(
          code,
          {
            filename: input.entry ?? "mutations/test.js",
            name: input.name,
            args: input.args ?? null,
            member: input.member === undefined ? "m-1" : input.member,
            owner: input.owner === true,
            now: 1_700_000_000_000,
            readonly: kind !== "mutation",
            kind,
            ownerName: "jihyeok",
          },
          host,
        ),
      );
      return { ok: true as const, result, operations };
    } catch (error) {
      if (error instanceof DataError)
        return {
          ok: false as const,
          status: error.status,
          message: error.message,
          code: error.code,
          details: error.details,
          site: error.site,
          operations,
        };
      return { ok: false as const, thrown: String(error), operations };
    }
  }

  /** What the scratch table holds now. */
  wallets() {
    return this.ctx.storage.sql
      .exec("SELECT id, balance FROM wallets ORDER BY id")
      .toArray();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const stub = env.HARNESS.get(
      env.HARNESS.idFromName(url.searchParams.get("object") ?? "a"),
    );
    if (url.pathname === "/wallets") return Response.json(await stub.wallets());
    return Response.json(await stub.call(await request.json()));
  },
} satisfies ExportedHandler<Env>;
