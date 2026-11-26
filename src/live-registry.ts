// A site object's live queries (site.ts), kept in its memory, with the
// `_naru_subscriptions` table only their checkpoint.
//
// What the table is for: an object put away with its sockets open
// (hibernation) wakes knowing nothing, and has to know again which live
// queries there are and which writes re-run each. Writing it on every
// subscribe and unsubscribe, though, wrote a busy site's database a hundred
// times a minute as visitors moved between pages, each through SQLite's WAL
// to the disk, for subscriptions most of which lasted seconds.
//
// So a change is made here, and the table brought up to date with all of
// them at once (`changes`), at most FLUSH_DELAY_MS after the first: a
// subscription that comes and goes within that is never written. An object
// is not put away while a timer is pending, so nothing it holds is lost to
// hibernation; one that stops (a restart) closes its sockets with it, and
// their clients subscribe again.
//
// The hash of the answer each subscription was last sent is kept here and
// never taken from the table: an object that wakes sends each subscription
// its answer, at worst one it already has, never holding back one it lacks.

/** A live query, as a socket subscribed to it. */
export type Subscription = {
  member: string | null;
  /** `file:fn` */
  query: string;
  /** The arguments, as JSON. */
  args: string;
  /** The tables it read, as JSON: which writes re-run it. */
  tables: string;
  /** The hash of the answer it was last sent, if this object sent one. */
  sent?: string;
};

/** A row of `_naru_subscriptions`. */
export type SubscriptionRow = {
  socket: string;
  id: string;
  member: string | null;
  query: string;
  args: string;
  tables: string;
  hash: string;
};

/** How long a change waits to be written with any after it. */
export const FLUSH_DELAY_MS = 30_000;

/** What the table is to be brought to: rows to write, and keys to delete. */
export type Changes = {
  upserts: SubscriptionRow[];
  deletes: { socket: string; id: string }[];
};

const keyOf = (socket: string, id: string) => `${socket}\n${id}`;

export class LiveRegistry {
  private sockets = new Map<string, Map<string, Subscription>>();
  /** What the table holds, by key: what was last written of each. */
  private stored = new Map<string, string>();
  /** Keys changed since the table was last brought up to date. */
  private dirty = new Set<string>();

  /** Takes the table's rows, as an object that wakes finds them. */
  load(rows: Iterable<SubscriptionRow>) {
    this.sockets = new Map();
    this.stored = new Map();
    this.dirty = new Set();
    for (const row of rows) {
      const { socket, id, member, query, args, tables } = row;
      this.subscriptionsOf(socket).set(id, { member, query, args, tables });
      this.stored.set(keyOf(socket, id), this.written(socket, id));
    }
  }

  /** The socket's subscriptions, made if it has none. */
  private subscriptionsOf(socket: string) {
    let subscriptions = this.sockets.get(socket);
    if (!subscriptions) this.sockets.set(socket, (subscriptions = new Map()));
    return subscriptions;
  }

  /** What the table would hold for a subscription, to tell a change by. */
  private written(socket: string, id: string): string {
    const s = this.sockets.get(socket)?.get(id);
    return s ? JSON.stringify([s.member, s.query, s.args, s.tables]) : "";
  }

  private touched(socket: string, id: string) {
    const key = keyOf(socket, id);
    if (this.written(socket, id) === (this.stored.get(key) ?? ""))
      this.dirty.delete(key);
    else this.dirty.add(key);
  }

  get(socket: string, id: string): Subscription | undefined {
    return this.sockets.get(socket)?.get(id);
  }

  /** Subscribes, or replaces what the socket's `id` was. */
  set(socket: string, id: string, subscription: Subscription) {
    this.subscriptionsOf(socket).set(id, subscription);
    this.touched(socket, id);
  }

  /** A refresh's answer: what it read, and the hash it was sent. */
  answered(socket: string, id: string, tables: string, sent: string) {
    const s = this.get(socket, id);
    if (!s) return;
    s.tables = tables;
    s.sent = sent;
    this.touched(socket, id);
  }

  unsubscribe(socket: string, id: string) {
    const subscriptions = this.sockets.get(socket);
    if (!subscriptions?.delete(id)) return;
    if (!subscriptions.size) this.sockets.delete(socket);
    this.touched(socket, id);
  }

  /** Forgets a socket's subscriptions, as it closes. */
  close(socket: string) {
    const subscriptions = this.sockets.get(socket);
    if (!subscriptions) return;
    this.sockets.delete(socket);
    for (const id of subscriptions.keys()) this.touched(socket, id);
  }

  /** How many subscriptions the socket holds, or the whole site. */
  count(socket?: string): number {
    if (socket !== undefined) return this.sockets.get(socket)?.size ?? 0;
    let n = 0;
    for (const subscriptions of this.sockets.values()) n += subscriptions.size;
    return n;
  }

  /** Every subscription, by socket and id. */
  *entries(): Generator<[socket: string, id: string, Subscription]> {
    for (const [socket, subscriptions] of this.sockets)
      for (const [id, subscription] of subscriptions)
        yield [socket, id, subscription];
  }

  /** Whether the table is behind what is here. */
  get behind(): boolean {
    return this.dirty.size > 0;
  }

  /** What would bring the table up to date with what is here. */
  changes(): Changes {
    const changes: Changes = { upserts: [], deletes: [] };
    for (const key of this.dirty) {
      const [socket, id] = key.split("\n");
      const s = this.get(socket, id);
      if (s)
        changes.upserts.push({
          socket,
          id,
          member: s.member,
          query: s.query,
          args: s.args,
          tables: s.tables,
          // The table needs one; it is not read back as an answer sent.
          hash: s.sent ?? "",
        });
      else if (this.stored.has(key)) changes.deletes.push({ socket, id });
    }
    return changes;
  }

  /** Marks `changes` as written to the table. */
  wrote(changes: Changes) {
    for (const { socket, id } of changes.deletes) {
      this.stored.delete(keyOf(socket, id));
      this.dirty.delete(keyOf(socket, id));
    }
    for (const { socket, id } of changes.upserts) {
      this.stored.set(keyOf(socket, id), this.written(socket, id));
      this.dirty.delete(keyOf(socket, id));
    }
  }
}
