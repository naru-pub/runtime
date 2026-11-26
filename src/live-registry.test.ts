import { describe, expect, test } from "vitest";
import {
  LiveRegistry,
  type Subscription,
  type SubscriptionRow,
} from "./live-registry";

const sub = (tables = '["posts"]', extra: Partial<Subscription> = {}) => ({
  member: null,
  query: "posts:list",
  args: "{}",
  tables,
  ...extra,
});

/** Writes the registry's changes to a Map standing in for the table. */
const flush = (live: LiveRegistry, table: Map<string, SubscriptionRow>) => {
  const changes = live.changes();
  for (const { socket, id } of changes.deletes) table.delete(`${socket}/${id}`);
  for (const row of changes.upserts) table.set(`${row.socket}/${row.id}`, row);
  live.wrote(changes);
  return changes;
};

describe("live queries in memory, the table their checkpoint", () => {
  test("a subscription that comes and goes before a flush is never written", () => {
    const live = new LiveRegistry();
    live.set("s1", "a", sub());
    expect(live.behind).toBe(true);
    live.unsubscribe("s1", "a");
    expect(live.behind).toBe(false);
    expect(live.changes()).toEqual({ upserts: [], deletes: [] });
  });

  test("a socket that closes before a flush writes nothing", () => {
    const live = new LiveRegistry();
    live.set("s1", "a", sub());
    live.set("s1", "b", sub());
    live.close("s1");
    expect(live.behind).toBe(false);
    expect(live.count()).toBe(0);
  });

  test("a flush writes what lasted, once, and nothing after", () => {
    const live = new LiveRegistry();
    const table = new Map<string, SubscriptionRow>();
    live.set("s1", "a", sub());
    expect(flush(live, table).upserts.map((r) => r.id)).toEqual(["a"]);
    expect(live.behind).toBe(false);
    expect(live.changes()).toEqual({ upserts: [], deletes: [] });
    expect(table.get("s1/a")?.query).toBe("posts:list");
  });

  test("one written is deleted when it ends, and only then", () => {
    const live = new LiveRegistry();
    const table = new Map<string, SubscriptionRow>();
    live.set("s1", "a", sub());
    flush(live, table);
    live.unsubscribe("s1", "a");
    expect(flush(live, table).deletes).toEqual([{ socket: "s1", id: "a" }]);
    expect(table.size).toBe(0);
  });

  test("a new answer is not a change; new tables are", () => {
    const live = new LiveRegistry();
    const table = new Map<string, SubscriptionRow>();
    live.set("s1", "a", sub('["posts"]', { sent: "h1" }));
    flush(live, table);
    live.answered("s1", "a", '["posts"]', "h2");
    expect(live.behind).toBe(false);
    expect(live.get("s1", "a")?.sent).toBe("h2");
    live.answered("s1", "a", '["posts","users"]', "h3");
    expect(live.behind).toBe(true);
    expect(flush(live, table).upserts[0].tables).toBe('["posts","users"]');
  });

  test("changed and changed back before a flush is no change", () => {
    const live = new LiveRegistry();
    const table = new Map<string, SubscriptionRow>();
    live.set("s1", "a", sub('["posts"]'));
    flush(live, table);
    live.answered("s1", "a", '["users"]', "h");
    live.answered("s1", "a", '["posts"]', "h");
    expect(live.behind).toBe(false);
  });

  test("an object that wakes has the table's, and no answer sent", () => {
    const live = new LiveRegistry();
    const table = new Map<string, SubscriptionRow>();
    live.set("s1", "a", sub('["posts"]', { sent: "h1" }));
    live.set("s2", "b", sub('["users"]', { member: "m" }));
    flush(live, table);

    const woken = new LiveRegistry();
    woken.load(table.values());
    expect(woken.count()).toBe(2);
    expect(woken.get("s1", "a")?.tables).toBe('["posts"]');
    expect(woken.get("s2", "b")?.member).toBe("m");
    // Never trusted: the woken object sends each its answer again.
    expect(woken.get("s1", "a")?.sent).toBeUndefined();
    expect(woken.behind).toBe(false);
    woken.close("s1");
    expect(woken.changes().deletes).toEqual([{ socket: "s1", id: "a" }]);
  });

  test("counts a socket's and the site's", () => {
    const live = new LiveRegistry();
    live.set("s1", "a", sub());
    live.set("s1", "b", sub());
    live.set("s2", "a", sub());
    live.set("s1", "a", sub('["users"]'));
    expect(live.count("s1")).toBe(2);
    expect(live.count("s3")).toBe(0);
    expect(live.count()).toBe(3);
    expect([...live.entries()].map(([s, id]) => `${s}/${id}`)).toEqual([
      "s1/a",
      "s1/b",
      "s2/a",
    ]);
  });
});
