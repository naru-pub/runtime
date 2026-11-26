import { describe, expect, test } from "vitest";
import { MinuteCounts } from "./minute-counts";

// The clock is each call's `now`: a fake one, in ms, at a minute's start.
const T = 1_800_000_000_000 - (1_800_000_000_000 % 60_000);
const SECOND = 1000;
const MINUTE = 60 * SECOND;

describe("calls a minute", () => {
  test("allow a limit's maximum, then refuse until the next minute", () => {
    const c = new MinuteCounts();
    for (let i = 0; i < 3; i++) expect(c.take([["call:a", 3]], T)).toBeNull();
    expect(c.take([["call:a", 3]], T + 59 * SECOND)).toBe("call:a");
    expect(c.take([["call:a", 3]], T + MINUTE)).toBeNull();
  });

  test("count in fixed minutes, not the 60 seconds before", () => {
    const c = new MinuteCounts();
    expect(c.take([["call:a", 1]], T + 59 * SECOND)).toBeNull();
    expect(c.take([["call:a", 1]], T + 59.5 * SECOND)).toBe("call:a");
    expect(c.take([["call:a", 1]], T + MINUTE)).toBeNull();
  });

  test("keep each key's count apart", () => {
    const c = new MinuteCounts();
    expect(c.take([["call:a", 1]], T)).toBeNull();
    expect(c.take([["call:b", 1]], T)).toBeNull();
    expect(c.take([["call:a", 1]], T)).toBe("call:a");
  });

  test("count a call against all its limits, or, refused by one, none", () => {
    const c = new MinuteCounts();
    const limits = [
      ["site", 3],
      ["ip:x", 1],
    ] as const;
    expect(c.take(limits, T)).toBeNull();
    // Refused by its address's limit: the site's is not spent by it.
    expect(c.take(limits, T)).toBe("ip:x");
    expect(c.take(limits, T)).toBe("ip:x");
    expect(
      c.take(
        [
          ["site", 3],
          ["ip:y", 1],
        ],
        T,
      ),
    ).toBeNull();
    expect(
      c.take(
        [
          ["site", 3],
          ["ip:z", 1],
        ],
        T,
      ),
    ).toBeNull();
    // Now the site's is spent, by three calls.
    expect(
      c.take(
        [
          ["site", 3],
          ["ip:w", 1],
        ],
        T,
      ),
    ).toBe("site");
  });

  test("forget every count when cleared", () => {
    const c = new MinuteCounts();
    expect(c.take([["call:a", 1]], T)).toBeNull();
    c.clear();
    expect(c.take([["call:a", 1]], T)).toBeNull();
  });
});
