import { describe, expect, test } from "vitest";
import { CONFIRMATION_WRITE_LAG_MS, Confirmation } from "./confirmation";

const T = 1_800_000_000_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const AHEAD = 3 * DAY;

describe("a site's confirmation", () => {
  test("is written by the first sync, to an object that has none", () => {
    expect(new Confirmation().take(T + AHEAD, 0)).toBe(true);
  });

  test("is held in memory, not written, by the syncs of the next day", () => {
    const c = new Confirmation();
    const written = T + AHEAD;
    for (let t = T + 5 * MINUTE; t <= T + DAY; t += 5 * MINUTE)
      expect(c.take(t + AHEAD, written)).toBe(false);
    expect(c.until(written)).toBe(T + DAY + AHEAD);
  });

  test("is written again once the written one falls a day behind", () => {
    const c = new Confirmation();
    const written = T + AHEAD;
    expect(c.take(written + CONFIRMATION_WRITE_LAG_MS, written)).toBe(false);
    expect(c.take(written + CONFIRMATION_WRITE_LAG_MS + 1, written)).toBe(true);
  });

  test("is written at once when a sync moves it back", () => {
    expect(new Confirmation().take(T + DAY, T + AHEAD)).toBe(true);
  });

  test("falls back to the written date in an object that has had no sync", () => {
    expect(new Confirmation().until(T + AHEAD)).toBe(T + AHEAD);
  });
});
