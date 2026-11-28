import { RpcTarget } from "cloudflare:workers";
import type { ModuleSources } from "./modules";
import {
  DataError,
  ERROR_CODES,
  type ErrorCode,
} from "./site-data/validation";

// Site code: the owner's queries, mutations and routes (_naru/queries/,
// _naru/mutations/, _naru/routes/), each release in a V8 isolate of its own
// that the site's object loads with a Worker Loader binding (`LOADER`). The
// isolate has no bindings and no network (`globalOutbound: null`): all it
// can do is answer `run`, and all its code can do through `ctx` is ask the
// object, over RPC, which runs each operation itself, checked as before
// (site.ts `siteHost`). A call runs inside the object's
// `ctx.storage.transaction()`, so its statements are one SQLite
// transaction, and other requests to the object wait for it to end.
//
// What bounds a call (spikes/workerd-isolates/README.md in Naru's
// repository):
// - CPU and the isolate's heap: Naru's workerd (NARU_DYNAMIC_CPU_MS and
//   NARU_DYNAMIC_HEAP_MB), for each call and for the modules' top-level
//   code. npm's workerd (naru-dev, the tests) enforces neither.
// - wall time, here: CALL_TIME_MS, after which the call fails and its ctx
//   answers nothing more, whatever the isolate is still doing;
// - the object's time, here: each ctx operation runs on the object, which
//   the isolate's CPU limit does not see. MAX_OBJECT_MS bounds their total,
//   and MAX_OPERATIONS their number, against loops of near-free ones.

/** A call's time from start to answer, its ctx operations included. */
export const CALL_TIME_MS = 2000;
/**
 * The object's time a call's ctx operations may take in all, in ms: what
 * its statements cost, which a count of them cannot say (100 indexed lookups
 * take about 2 ms, three table scans can take 150). Checked after each
 * operation, so one statement may pass it; the runtime's step budget bounds
 * that one.
 */
export const MAX_OBJECT_MS = 200;
/**
 * Database operations a call may make, writes included: a guard against
 * runaway loops of near-free ones, whose RPCs MAX_OBJECT_MS does not see.
 */
export const MAX_OPERATIONS = 1000;
/** What a call may return, as JSON: a page of rows (sql.ts's MAX_ROW_BYTES). */
export const MAX_RESULT_BYTES = 1024 * 1024;
export const MAX_FAILURE_DETAILS_BYTES = 4 * 1024;
/**
 * Password hashes and checks a call may make (ctx.passwords): each is a few
 * milliseconds of the object's time.
 */
export const MAX_PASSWORD_OPERATIONS = 3;

/** What site code may do: one call per ctx method, given its arguments. */
export type Host = (operation: string, args: unknown[]) => unknown;

export type Invocation = {
  /** The entry module, such as `queries/shop.js`. */
  filename: string;
  name: string;
  args: unknown;
  member: string | null;
  /** The site's owner called, rather than a member or the site itself. */
  owner?: boolean;
  now: number;
  /** Site SQL may only read: a query's or a route's. */
  readonly?: boolean;
  /**
   * What is called: a query or a route, which only read, or a mutation,
   * which may also hash passwords and notify members.
   */
  kind: "query" | "mutation" | "route";
  /** The site's owner's Naru login (`ctx.ownerName`). */
  ownerName?: string;
};

/** What `run` answers (the entry below). */
type Answer =
  | { result: string }
  | { missing: true }
  | { error: { name: string; message: string } }
  | { fail: unknown[] }
  | { unawaited: string };

/** A release's isolate, as the Worker Loader gives it. */
export interface SiteCode {
  run(
    invocation: Omit<Invocation, "readonly">,
    host: CallHost,
  ): Promise<Answer>;
}

/** The Worker Loader binding (workerd's `workerLoader`). */
export interface Loader {
  get(
    name: string,
    getCode: () => Promise<WorkerCode>,
  ): { getEntrypoint(): SiteCode };
}

export interface WorkerCode {
  compatibilityDate: string;
  compatibilityFlags?: string[];
  mainModule: string;
  modules: Record<string, { js: string }>;
  env: Record<string, never>;
  globalOutbound: null;
}

const failed = (message: string) =>
  new DataError(400, `Function failed: ${message}`);

/** The module Naru adds to a release's isolate, as its entry. */
export const ENTRY_MODULE = "_naru_entry.js";
/**
 * Imported first, so it runs before any of the site's modules: what site code
 * logs would otherwise reach the server's own log, which no site may fill.
 */
const QUIET_MODULE = "_naru_quiet.js";
const QUIET_SOURCE = `for (const name of Object.keys(console)) console[name] = () => {};\n`;

/**
 * The isolate's code: the release's modules (`modules`, by their names under
 * `_naru/`) and an entry that imports every module in `entries`, the ones a
 * call may name.
 */
export function workerCode(
  modules: ModuleSources,
  entries: string[],
): WorkerCode {
  return {
    compatibilityDate: "2026-10-01",
    // Node compatibility is on by default since 2026-08-04: process,
    // node:* modules. Site code needs none of it, and each API is more
    // surface for a V8 or runtime bug.
    compatibilityFlags: ["no_nodejs_compat", "no_nodejs_compat_v2"],
    mainModule: ENTRY_MODULE,
    modules: {
      ...Object.fromEntries(
        Object.entries(modules).map(([name, js]) => [name, { js }]),
      ),
      [QUIET_MODULE]: { js: QUIET_SOURCE },
      [ENTRY_MODULE]: { js: entrySource(entries) },
    },
    env: {},
    globalOutbound: null,
  };
}

// The isolate's side of ctx: one RPC entry point back to the object,
// `host.op(operation, args)`, answered with the operation's value and the
// target for the next operation. workerd hands an RpcTarget made inside a
// critical section (the call's transaction) that section on its first call
// only, so a second call on the same target would wait for the transaction
// to end; made during an operation, each next target carries it. Operations
// therefore go one at a time, in the order the code makes them.
//
// A failing ctx operation fails the whole call (the object keeps the error
// and answers with it), so site code cannot carry on past one. Each
// operation's promise must be used (awaited, chained or passed to
// Promise.all), or the call fails: `if (!ctx.passwords.verify(...))` is
// always false, a mistake no error would otherwise reveal. A native promise
// cannot tell when it is awaited, so these are a subclass whose then() is
// observable; what then() returns is a plain promise.
const entrySource = (entries: string[]) => `
import "./${QUIET_MODULE}";
import { WorkerEntrypoint } from "cloudflare:workers";
${entries.map((file, i) => `import * as m${i} from ${JSON.stringify(`./${file}`)};`).join("\n")}
const entries = { ${entries.map((file, i) => `${JSON.stringify(file)}: m${i}`).join(", ")} };

class CtxPromise extends Promise {
  static get [Symbol.species]() { return Promise; }
  then(onFulfilled, onRejected) {
    this.unused?.delete(this);
    return super.then(onFulfilled, onRejected);
  }
}

// BLOBs cross as { $blob: base64 }: Uint8Arrays are bound as BLOBs, and BLOB
// columns come back as Uint8Arrays.
const toBlob = (value) => {
  if (value instanceof ArrayBuffer) value = new Uint8Array(value);
  if (!ArrayBuffer.isView(value)) return value;
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { $blob: btoa(text) };
};
const fromBlob = (value) => {
  if (!value || typeof value !== "object" || typeof value.$blob !== "string") return value;
  const text = atob(value.$blob);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
};

export default class extends WorkerEntrypoint {
  async run(call, host) {
    const unused = new Map();
    let queue = Promise.resolve();
    const send = (operation, args) => {
      const answer = queue.then(async () => {
        const { value, next } = await host.op(operation, args);
        host = next;
        return value;
      });
      queue = answer.then(() => {}, () => {});
      return answer;
    };
    const operation = (name, decode = (value) => value) => (...args) => {
      const promise = new CtxPromise((resolve, reject) =>
        send(name, args).then((value) => resolve(decode(value)), reject),
      );
      promise.unused = unused;
      unused.set(promise, name);
      return promise;
    };
    let failure;
    const fail = (...args) => {
      failure ??= args;
      throw new Error(String(args[1] ?? "ctx.fail"));
    };
    const sqlResult = (result) => ({
      ...result,
      rows: result.rows.map((row) => {
        for (const key of Object.keys(row)) row[key] = fromBlob(row[key]);
        return row;
      }),
    });
    const runSql = operation("sql", sqlResult);
    // ctx.sql\`SELECT ... WHERE id = \${id}\` binds each value as a parameter;
    // ctx.sql(text, values) takes a query builder's compiled statement.
    const sql = (text, ...values) => {
      const [statement, bound] =
        Array.isArray(text) && Object.hasOwn(text, "raw")
          ? [text.join("?"), values]
          : [String(text), values[0] ?? []];
      return runSql(statement, Array.isArray(bound) ? bound.map(toBlob) : bound);
    };
    const passwords = Object.freeze({
      hash: operation("passwordHash"),
      verify: operation("passwordVerify"),
    });
    const mutation = call.kind === "mutation";
    const ctx = Object.freeze({
      member: call.member === null ? null : Object.freeze({ id: call.member }),
      owner: call.owner === true,
      ownerName: call.ownerName ?? "",
      now: call.now,
      fail,
      sql,
      passwords: mutation ? passwords : Object.freeze({ verify: passwords.verify }),
      // A notification in the Naru app for members, sent once the call commits.
      ...(mutation ? { notify: operation("notify") } : {}),
    });
    const module = entries[call.filename];
    const fn = module && Object.hasOwn(module, call.name) ? module[call.name] : undefined;
    if (typeof fn !== "function") return { missing: true };
    let result;
    try {
      // No arguments arrive as undefined, so default parameters apply:
      // \`function f(ctx, { board } = {})\` works when the page sends none.
      result = JSON.stringify((await fn(ctx, call.args === null ? undefined : call.args)) ?? null);
    } catch (error) {
      if (failure) return { fail: failure };
      return { error: { name: String(error?.name ?? "Error"), message: String(error?.message ?? error) } };
    }
    if (failure) return { fail: failure };
    // What the code started but never awaited ends before the call does.
    await queue;
    const unawaited = unused.values().next().value;
    if (unawaited !== undefined) return { unawaited };
    return { result };
  }
}
`;

/** What a call's ctx shares across the targets it is answered through. */
type CallState = {
  host: Host;
  kind: Invocation["kind"];
  readonly: boolean;
  operations: number;
  passwords: number;
  /** The object's time in the call's operations so far, in ms. */
  objectMs: number;
  /** The first failed operation, which fails the call even if caught. */
  error?: DataError;
  /** Set when the call has answered: later operations are refused. */
  closed: boolean;
};

/**
 * The object's side of ctx: each operation, checked and counted here, then
 * run by the call's host (site.ts), and the target for the next.
 */
export class CallHost extends RpcTarget {
  #state: CallState;
  constructor(state: CallState) {
    super();
    this.#state = state;
  }
  op(name: unknown, args: unknown) {
    const state = this.#state;
    if (state.closed) throw new Error("This call has ended.");
    try {
      if (state.error) throw state.error;
      if (typeof name !== "string" || !Array.isArray(args))
        throw failed("a ctx operation was malformed.");
      // Site code reaches the site's tables through sql alone.
      if (
        !["sql", "passwordVerify"].includes(name) &&
        !(
          state.kind === "mutation" &&
          (name === "passwordHash" || name === "notify")
        )
      )
        throw failed(`a ${state.kind} has no ctx.${name}.`);
      // A password is checked with a slow hash, on the host.
      if (
        (name === "passwordHash" || name === "passwordVerify") &&
        ++state.passwords > MAX_PASSWORD_OPERATIONS
      )
        throw failed(
          `more than ${MAX_PASSWORD_OPERATIONS} password operations.`,
        );
      if (++state.operations > MAX_OPERATIONS)
        throw failed(`more than ${MAX_OPERATIONS} database operations.`);
      // Whether site SQL may write is the call's to say, not the code's.
      // workerd's clock advances while a statement runs, which Cloudflare's
      // would not: this runtime runs on Naru's own servers.
      const started = performance.now();
      const value = state.host(
        name,
        name === "sql" ? [args[0], args[1], state.readonly] : args,
      );
      state.objectMs += performance.now() - started;
      if (state.objectMs > MAX_OBJECT_MS)
        throw failed("its database work ran too long.");
      return {
        value: value === undefined ? null : value,
        next: new CallHost(state),
      };
    } catch (error) {
      state.error ??=
        error instanceof DataError
          ? error
          : new DataError(500, "Site storage failed.");
      throw new Error(state.error.message);
    }
  }
}

/** A `ctx.fail(code, message, details)`, as the error the caller gets. */
function siteFailure(args: unknown[]): DataError {
  const [code, message, details = null] = args;
  if (
    !ERROR_CODES.includes(code as ErrorCode) ||
    typeof message !== "string" ||
    !message.trim() ||
    message.length > 1000
  )
    return failed(
      "ctx.fail requires a v1 error code and a message of 1–1000 characters.",
    );
  // The caller's own JSON: a reason the page can branch on, say.
  let size: number;
  try {
    size = new TextEncoder().encode(JSON.stringify(details)).byteLength;
  } catch {
    return failed("ctx.fail details must be JSON.");
  }
  if (details !== null && size > MAX_FAILURE_DETAILS_BYTES)
    return failed("ctx.fail details must be at most 4 KiB of JSON.");
  const status: Record<ErrorCode, number> = {
    CONFLICT: 409,
    QUOTA_EXCEEDED: 409,
    AUTH_REQUIRED: 401,
    ACCESS_DENIED: 403,
    NOT_FOUND: 404,
    RATE_LIMITED: 429,
    INVALID_REQUEST: 400,
    UNAVAILABLE: 503,
  };
  return new DataError(
    status[code as ErrorCode],
    message,
    code as ErrorCode,
    details ?? undefined,
    true,
  );
}

/** What the runtime's own stopping of a call says, as the code's failure. */
function runtimeFailure(error: unknown): DataError | undefined {
  const text = String((error as Error)?.message ?? error);
  if (/exceeded CPU time limit/i.test(text)) return failed("it ran too long.");
  if (/exceeded memory limit|out of memory/i.test(text))
    return failed("it used too much memory.");
  if (/never generate a response|will never (resolve|complete)/i.test(text))
    return failed("it awaited something other than ctx, which never settles.");
  const start = /Failed to start Worker:\s*([\s\S]*)/.exec(text);
  if (start) return failed(`its module does not load: ${start[1].trim()}`);
  return undefined;
}

/**
 * Runs `invocation` in the release's isolate (`code`), with `host` for its
 * ctx. Returns what it returned (or resolved with), parsed from its JSON.
 * Throws a DataError: the host's own when a ctx operation failed, otherwise
 * a 400 describing the function's failure or limit. Anything else is the
 * runtime's own failure. The caller runs this inside the call's transaction.
 */
export async function runFunction(
  code: SiteCode,
  invocation: Invocation,
  host: Host,
): Promise<unknown> {
  const state: CallState = {
    host,
    kind: invocation.kind,
    readonly: invocation.readonly === true,
    operations: 0,
    passwords: 0,
    objectMs: 0,
    closed: false,
  };
  const { readonly: _readonly, ...call } = invocation;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let answer: Answer;
  try {
    answer = await Promise.race([
      code.run({ ...call, args: invocation.args ?? null }, new CallHost(state)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(failed("it ran too long.")),
          CALL_TIME_MS,
        );
      }),
    ]);
  } catch (error) {
    if (state.error) throw state.error;
    if (error instanceof DataError) throw error;
    const limit = runtimeFailure(error);
    if (limit) throw limit;
    throw error;
  } finally {
    clearTimeout(timer);
    state.closed = true;
  }
  if (state.error) throw state.error;
  if ("missing" in answer)
    throw new DataError(404, `No function ${invocation.name}.`);
  if ("fail" in answer) throw siteFailure(answer.fail);
  if ("error" in answer) {
    const limit = runtimeFailure(answer.error.message);
    throw limit ?? failed(`${answer.error.name}: ${answer.error.message}`);
  }
  if ("unawaited" in answer)
    throw failed(`it did not await ctx.${answer.unawaited}.`);
  if (new TextEncoder().encode(answer.result).byteLength > MAX_RESULT_BYTES)
    throw failed("its result is larger than 1 MiB.");
  return JSON.parse(answer.result);
}
