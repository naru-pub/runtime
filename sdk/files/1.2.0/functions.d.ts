/**
 * What Naru hands a site's own code (SDK 1.2.0): queries in
 * `_naru/queries/`, mutations in `_naru/mutations/` and routes in
 * `_naru/routes.js`, run on Naru over the tables `_naru/migrations/*.sql`
 * create. For type checking only; nothing here exists at run time.
 *
 * ```ts
 * import type { Query, Mutation } from "./functions.d.ts";
 * export const posts: Query<{ board: string }> = async (ctx, { board }) =>
 *   (await ctx.sql`SELECT id, title FROM posts WHERE board = ${board}`).rows;
 * ```
 *
 * The code runs in a V8 isolate of its own, one for each release of the
 * site's code, with the globals of a Cloudflare Worker: the language's own,
 * and URL, structuredClone, Intl, TextEncoder and TextDecoder, atob and btoa,
 * crypto (getRandomValues and subtle), timers, performance.now and the like.
 * It has no network (fetch throws), no bindings, and compiles no code at run
 * time (eval, new Function and WebAssembly.compile throw); console output is
 * discarded. Date.now is the server's clock: prefer `ctx.now`, and since
 * local time is the server's, use UTC methods.
 *
 * Module-level values live as long as the isolate, across calls and callers:
 * a cache of something every caller may see is fine there; anything about
 * one caller belongs in `ctx` or a table.
 *
 * Written by hand beside the generated naru.d.ts, whose `Json` this repeats
 * so this file stands on its own.
 * @packageDocumentation
 */

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };

/** The failure codes `ctx.fail` takes, as pages receive them in `error.code`. */
export type ErrorCode =
  | "CONFLICT"
  | "QUOTA_EXCEEDED"
  | "AUTH_REQUIRED"
  | "ACCESS_DENIED"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "INVALID_REQUEST"
  | "UNAVAILABLE";

/**
 * The member who called: their ID on this site, the same on every visit.
 * What they may do is the site's to keep, in its own tables.
 */
export interface CallingMember {
  readonly id: string;
}

/** A value site SQL binds or returns (a boolean binds as 1 or 0). */
export type SqlValue = string | number | boolean | Uint8Array | null;
/** What `ctx.sql` answers: the statement's rows, and how many it changed. */
export interface SqlResult<Row> {
  rows: Row[];
  changes: number;
}

/**
 * A query's or route's `ctx`: who calls, and the site's own tables through
 * `sql`. Anyone may call one, signed in or not, so its code decides what
 * each caller may see. A query's `sql` only reads. A call runs in one
 * transaction, for at most 50 ms of CPU and 2 seconds in all, in a release's
 * 64 MiB heap, makes at most 1,000 database operations taking at most 200 ms
 * in all, reads at most 2,000,000 rows in all, and returns at most 1 MiB of
 * JSON. Every method's promise must
 * be used (awaited, returned or chained), or the call fails.
 */
export interface QueryCtx {
  /** The signed-in member, or null for the owner and visitors. */
  readonly member: CallingMember | null;
  /** The site's owner called. A visitor, signed in to nothing, has neither. */
  readonly owner: boolean;
  /** The site's owner's Naru login, whoever calls: the site's own name. */
  readonly ownerName: string;
  /** The call's time in milliseconds, fixed for the whole call. */
  readonly now: number;
  /**
   * Refuses the request: nothing the call wrote is kept, and the page's
   * `error.message` is `message` (1–1000 characters) as written, so write it
   * for visitors. `details`, at most 4 KiB of JSON, arrives as
   * `error.details`.
   */
  fail(code: ErrorCode, message: string, details?: Json): never;
  /**
   * One statement of SQL against the site's own tables, which its
   * `_naru/migrations/*.sql` create. As a tag, ``ctx.sql`... ${value}` ``
   * binds every interpolated value as a parameter; given text and values,
   * it runs a query builder's compiled statement. SELECT, INSERT, UPDATE and
   * DELETE run; a query only reads. Naru's own tables, pragmas, triggers,
   * transactions and recursion are refused, but Naru's view
   * `_naru_uploads (id, url, member, name, type, size, created_at)`, the
   * owner's and members' finished uploads (`member` null for the owner's;
   * visitors' uploads are not listed), may be read
   * and joined. A statement is stopped once
   * SQLite works on one step of it for 3 seconds; one stopped 3 times within
   * a minute is paused for 5 minutes. It binds at most 100 values, returns at most 1,000 rows and 1 MiB, BLOB columns as
   * Uint8Arrays, and counts as one database operation; a call's statements
   * read at most 2,000,000 rows. A value a UNIQUE column already holds fails
   * the call with CONFLICT, `details.unique` naming the column; any other
   * mistake SQLite refuses, with its message.
   *
   * To stay fast, read a table whole at most once and reach every other
   * table by key (join on an indexed column):
   *
   * - A list as one value: `WHERE id IN (SELECT value FROM json_each(?))`,
   *   bound as `JSON.stringify(ids)`.
   * - A row's JSON column: `FROM visits, json_each(visits.hours) j`.
   * - An ordered aggregate per row: `(SELECT json_group_array(title) FROM
   *   (SELECT title FROM titles WHERE ch = c.id ORDER BY ord))`, with an
   *   index on `titles (ch, ord)`.
   * - Past 1,000 rows: `WHERE id > ? ORDER BY id LIMIT 1000`, then again
   *   after the last `id`.
   */
  sql<Row = Record<string, SqlValue>>(
    strings: TemplateStringsArray,
    ...values: SqlValue[]
  ): Promise<SqlResult<Row>>;
  sql<Row = Record<string, SqlValue>>(
    text: string,
    values?: SqlValue[],
  ): Promise<SqlResult<Row>>;
  /**
   * Guests' passwords, kept by the site as hashes. `verify` allows ten wrong
   * passwords an hour for each `key` (such as "post:42"), whoever tries,
   * then fails with RATE_LIMITED. A call makes at most 3 password checks.
   */
  passwords: {
    verify(password: string, hash: string, key: string): Promise<boolean>;
  };
}

/** A mutation's `ctx`: a query's, writing, and notifying members. */
export interface MutationCtx extends QueryCtx {
  passwords: QueryCtx["passwords"] & {
    /** A hash of `password` (1–256 characters) to keep in a table. */
    hash(password: string): Promise<string>;
  };
  /**
   * Notifies these members (at most 1,000 a call) in the Naru app, once the
   * mutation returns: on their devices if they allowed the site there, or in
   * the app's inbox until they do. Unknown, pending and banned members are
   * skipped, and the site is not told who has the app. `path` (default "/")
   * is a page of this site, opened when the notification is tapped. A title
   * longer than 100 characters or a body longer than 500 is cut to fit.
   * Notifications are best effort: one Naru cannot queue is dropped, and the
   * mutation goes on. Member ids that are not ids, a blank title or another
   * site's address still throw.
   */
  notify(
    members: string[],
    message: { title: string; body?: string; path?: string },
  ): Promise<null>;
}

/** `export async function name(ctx, args)` in `_naru/queries/` or `_naru/mutations/`. */
export type Query<Args = Json, Result = Json> = (
  ctx: QueryCtx,
  args: Args,
) => Result | Promise<Result>;
export type Mutation<Args = Json, Result = Json> = (
  ctx: MutationCtx,
  args: Args,
) => Result | Promise<Result>;

/** What a route is asked. */
export interface RouteRequest {
  /** The path as asked, still percent-encoded. */
  path: string;
  /** The subdomain or custom domain it was asked on, such as `https://alice.naru.pub`. */
  origin: string;
  /** The query string's values, the last of a repeated name. */
  query: Record<string, string>;
}
/**
 * What a route answers: a string of HTML, a body of one of these types, one
 * of the site's files with `head` added to its `<head>` when it is HTML, or a
 * redirect to a path or an `https://` URL. `status` is 200–599 (a redirect's
 * 301, 302, 303, 307 or 308, by default 302); `cache` the seconds (0–300) the
 * edge may keep the page, by default 0.
 */
export type RouteAnswer =
  | string
  | ({ status?: number; cache?: number } & (
      | {
          body: string;
          type:
            | "text/html"
            | "text/plain"
            | "text/css"
            | "text/calendar"
            | "text/xml"
            | "application/xml"
            | "application/rss+xml"
            | "application/atom+xml"
            | "application/json";
        }
      | { file: string; head?: string }
      | { redirect: string }
    ));
/** `export default async function (ctx, request)` in `_naru/routes.js`. */
export type Route = (
  ctx: QueryCtx,
  request: RouteRequest,
) => RouteAnswer | Promise<RouteAnswer>;
