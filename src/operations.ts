import { DUMP_CONTENT_TYPE } from "./site-data/dump-format";
import type { DataError } from "./site-data/validation";
import {
  admit,
  breakers,
  settle,
  type CallIdentity,
  type Paused,
} from "./breaker";
import { notifyPending } from "./notify";
import type { SiteData } from "./site";
import { interruptedCall } from "./sql";
import type { Outcome } from "./types";

// The operations on site databases, wherever their objects are: on the mini
// (Naru's servers) and in naru-dev (dev.ts). Each is
// /v1/sites/<site>/<operation>: POST with a JSON body, answered with
// `{ value }` or `{ error: { status, message, code } }` at that status. A
// site's object is named by the site, so every request for a site meets the
// same one. Dumps (DUMP_OPERATIONS) are NDJSON instead (dump-format.ts),
// streamed both ways: `dump` answers one as its body, and `restore` takes one
// as its own; their refusals are JSON as above. The caller checks the bearer
// secret (authorized) before handing a request here.

export interface OperationsEnv {
  /** The site databases. Unbound, /v1/sites is not found. */
  SITES?: DurableObjectNamespace<SiteData>;
  /**
   * "1" opens TEST_OPERATIONS. Only test harnesses and naru-dev set it;
   * production never does.
   */
  TEST_OPERATIONS?: string;
  /**
   * The runtime's step budget for one SQLite statement, in ms, where it has
   * one, for saying so when it stops one.
   */
  SQLITE_STATEMENT_TIMEOUT_MS?: string;
}

const OPERATIONS = [
  "execute",
  "batch",
  "collections",
  "createCollections",
  "configureCollections",
  "mediaReferences",
  "siteTables",
  // The last days by the hour, as the owner's listing has them, read
  // without claiming the object: for the operators' views.
  "hourlyUsage",
  // A page of one of the site's tables, for the owner's control panel.
  "tableRows",
  // One read-only statement of the owner's own SQL, from the same tab.
  "ownerQuery",
  // Uploads as Naru Media finishes and deletes them, for site SQL's _naru_uploads.
  "recordMedia",
  "forgetMedia",
  "render",
  "erase",
  "configure",
  "call",
  "activateFunctions",
  // The tables a template version's migrations make, run on an object no
  // site uses and rolled back (the control plane's board).
  "trialMigrations",
  // Returning a site to a restore point its object kept in R2 (1.1.0), and
  // keeping one when the owner asks.
  "restoreFrom",
  "saveRestorePoint",
  "disconnect",
  // A site's whole database, as NDJSON (the control plane's backups).
  "dump",
  "restore",
  // The site's paused statements (breaker.ts): its latest pauses, the
  // operators told of them, and the owner letting one run again.
  "breakerTrips",
  "ackBreakerTrips",
  "clearBreaker",
  // ctx.notify's queue (notify.ts), for the control plane's app-notifications job.
  "notifyOutbox",
  "ackNotifyOutbox",
] as const;
// Read and replace a whole site, ids and times included: for tests to plant
// and inspect what the public operations cannot. Not found in production.
const TEST_OPERATIONS = [
  "export",
  "import",
  "putFunctions",
  // What dumps and restores leave of their own tables, and a restore point
  // planted in R2 as an older release wrote it.
  "internalTables",
  "putRestorePoint",
] as const;
type Operation = (typeof OPERATIONS)[number] | (typeof TEST_OPERATIONS)[number];
/** The operations whose request body is a dump, read as it arrives. */
const DUMP_OPERATIONS: readonly string[] = ["restore"];

// Site names.
const SITE = /^[a-zA-Z0-9_-]{1,64}$/;

// A stub's methods are remote calls, so each is named rather than looked up.
function dispatch(
  stub: DurableObjectStub<SiteData>,
  operation: Operation,
  input: never,
) {
  switch (operation) {
    case "execute":
      return stub.execute(input);
    case "batch":
      return stub.batch(input);
    case "collections":
      return stub.collections(input);
    case "createCollections":
      return stub.createCollections(input);
    case "configureCollections":
      return stub.configureCollections(input);
    case "mediaReferences":
      return stub.mediaReferences(input);
    case "siteTables":
      return stub.siteTables();
    case "hourlyUsage":
      return stub.hourlyUsage();
    case "trialMigrations":
      return stub.trialMigrations(input);
    case "tableRows":
      return stub.tableRows(input);
    case "ownerQuery":
      return stub.ownerQuery(input);
    case "render":
      return stub.render(input);
    case "recordMedia":
      return stub.recordMedia(input);
    case "forgetMedia":
      return stub.forgetMedia(input);
    case "export":
      return stub.export();
    case "import":
      return stub.import(input);
    case "erase":
      return stub.erase();
    case "configure":
      return stub.configure(input);
    case "call":
      return stub.call(input);
    case "activateFunctions":
      return stub.activateFunctions(input);
    case "disconnect":
      return stub.disconnect(input);
    case "restoreFrom":
      return stub.restoreFrom(input);
    case "saveRestorePoint":
      return stub.saveRestorePoint(input);
    case "dump":
      return stub.dump();
    case "internalTables":
      return stub.internalTables(input);
    case "putRestorePoint":
      return stub.putRestorePoint(input);
    case "restore":
      return stub.restore(input);
    case "putFunctions":
      return stub.putFunctions(input);
    case "breakerTrips":
      return stub.breakerTrips(input);
    case "ackBreakerTrips":
      return stub.ackBreakerTrips(input);
    case "notifyOutbox":
      return stub.notifyOutbox(input);
    case "ackNotifyOutbox":
      return stub.ackNotifyOutbox(input);
    case "clearBreaker":
      return stub.clearBreakerTrips(input);
  }
}

/** The site's function a call or a render runs, as breakers name it. */
function callOf(operation: string, input: unknown): CallIdentity | null {
  const given = input as {
    kind?: unknown;
    file?: unknown;
    name?: unknown;
  } | null;
  if (
    operation === "call" &&
    typeof given?.file === "string" &&
    typeof given.name === "string" &&
    (given.kind === "query" ||
      given.kind === "mutation" ||
      given.kind === "route")
  )
    return { kind: given.kind, file: given.file, name: given.name };
  if (operation === "render")
    return { kind: "route", file: "routes", name: "default" };
  return null;
}

export function failure(
  status: number,
  message: string,
  error?: Pick<DataError, "code" | "details">,
) {
  return Response.json(
    {
      error: {
        status,
        message,
        ...(error?.code ? { code: error.code } : {}),
        ...(error?.details === undefined ? {} : { details: error.details }),
      },
    },
    { status },
  );
}

export async function authorized(request: Request, secret: string | undefined) {
  if (!secret) return false;
  const given = new TextEncoder().encode(
    request.headers.get("authorization") ?? "",
  );
  const expected = new TextEncoder().encode(`Bearer ${secret}`);
  return (
    given.byteLength === expected.byteLength &&
    crypto.subtle.timingSafeEqual(given, expected)
  );
}

/**
 * The site operations and the queues beside them, for an authorized request
 * on a platform host; null for any other path.
 */
export async function siteOperation(
  request: Request,
  env: OperationsEnv,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  // Sites with notifications ctx.notify queued (notify.ts), for the
  // control plane's app-notifications job; ackNotifyOutbox takes a site off.
  if (pathname === "/v1/notifications/pending")
    return request.method === "POST"
      ? Response.json({ value: { sites: [...notifyPending] } })
      : failure(405, "Method not allowed.");
  // Sites with pauses the operators have not been told of (breaker.ts),
  // for the control plane's alerts; ackBreakerTrips takes a site off.
  if (pathname === "/v1/breakers/unnotified")
    return request.method === "POST"
      ? Response.json({ value: { sites: [...breakers.unnotified] } })
      : failure(405, "Method not allowed.");
  const match = /^\/v1\/sites\/([^/]+)\/([A-Za-z]+)$/.exec(pathname);
  const site = match && decodeURIComponent(match[1]);
  const operation = match?.[2] as Operation | undefined;
  const operations: readonly string[] =
    env.TEST_OPERATIONS === "1"
      ? [...OPERATIONS, ...TEST_OPERATIONS]
      : OPERATIONS;
  if (!match) return null;
  if (
    !env.SITES ||
    !site ||
    !SITE.test(site) ||
    !operations.includes(operation!)
  )
    return failure(404, "Not found.");
  if (request.method !== "POST") return failure(405, "Method not allowed.");
  let input: unknown;
  if (DUMP_OPERATIONS.includes(operation!)) {
    if (!request.body) return failure(400, "Expected a dump.");
    input = request.body;
  } else
    try {
      input = await request.json();
    } catch {
      return failure(400, "Expected a JSON body.");
    }
  // A restore point is read from (or written to) the site the URL names,
  // whose object this is, never one the body names.
  if (operation === "restoreFrom" || operation === "saveRestorePoint")
    input = { ...(input as object), site } satisfies { site: string };
  // A call or a render of the site's code: refused here when its function
  // is paused, else told the site's paused statements (breaker.ts).
  const call = callOf(operation!, input);
  if (call) {
    const admitted = admit(site, call);
    if (admitted.refusal)
      return Response.json(
        {
          error: {
            status: admitted.refusal.status,
            message: admitted.refusal.message,
            code: admitted.refusal.code,
            details: admitted.refusal.details,
            retryAfter: admitted.refusal.retryAfter,
          },
        },
        {
          status: admitted.refusal.status,
          headers: { "Retry-After": String(admitted.refusal.retryAfter) },
        },
      );
    input = { ...(input as object), site, paused: admitted.paused };
  }
  // The owner lets a paused statement (or all) run again: forgotten here,
  // and the object told what is still paused.
  if (operation === "clearBreaker") {
    const key = (input as { key?: unknown }).key;
    breakers.clear(site, typeof key === "string" ? key : undefined);
    input = {
      ...(input as object),
      paused: breakers.paused(site, Date.now()) satisfies Paused[],
    };
  }
  const stub = env.SITES.get(env.SITES.idFromName(site));
  // Each operation takes one argument object; the object validates it.
  let outcome: Outcome<unknown>;
  try {
    outcome = (await dispatch(
      stub,
      operation!,
      input as never,
    )) as Outcome<unknown>;
    if (call) settle(env.SITES, ctx, site, call);
  } catch (error) {
    if (call) settle(env.SITES, ctx, site, call, error);
    // A write the runtime stopped at its step budget reset the object
    // (sql.ts, `interrupted`): the site's own statement in a call or a
    // release's migrations, or one of Naru's.
    const refusal = interruptedCall(
      error,
      env,
      operation === "call"
        ? "site"
        : operation === "activateFunctions" ||
            operation === "putFunctions" ||
            operation === "trialMigrations"
          ? "migrations"
          : "naru",
    );
    if (!refusal) throw error;
    return failure(refusal.status, refusal.message, refusal);
  }
  // A new release's code starts with no statement paused.
  if (
    outcome.ok &&
    (operation === "activateFunctions" ||
      (operation === "putFunctions" &&
        (input as { publish?: unknown }).publish === true))
  )
    breakers.clear(site);
  if (outcome.ok && operation === "breakerTrips") {
    // Whether each is paused now: this Worker's memory, not the record.
    const paused = new Map(
      breakers
        .paused(site, Date.now())
        .map((pause) => [pause.key, pause.until]),
    );
    outcome = {
      ok: true,
      value: (outcome.value as { key: string; until: number }[]).map(
        (trip) => ({
          ...trip,
          pausedUntil:
            paused.get(trip.key) === trip.until ? trip.until : null,
        }),
      ),
    };
  }
  if (
    outcome.ok &&
    operation === "ackBreakerTrips" &&
    (outcome.value as { unnotified: number }).unnotified === 0
  )
    breakers.unnotified.delete(site);
  if (
    outcome.ok &&
    operation === "ackNotifyOutbox" &&
    (outcome.value as { pending: number }).pending === 0
  )
    notifyPending.delete(site);
  if (outcome.ok && operation === "dump")
    return new Response(outcome.value as ReadableStream<Uint8Array>, {
      headers: { "Content-Type": DUMP_CONTENT_TYPE },
    });
  return outcome.ok
    ? // JSON drops `undefined`; the caller tells success by `value`.
      Response.json({ value: outcome.value ?? null })
    : Response.json(
        { error: outcome.error },
        {
          status: outcome.error.status,
          headers: outcome.error.retryAfter
            ? { "Retry-After": String(outcome.error.retryAfter) }
            : {},
        },
      );
}
