// Calls a minute, counted in a site object's memory: visitors' and members'
// mutations and public writes (site.ts's limitVisitor, limitMember and
// limitPublicWrite), in fixed-minute buckets.
//
// They were rows of the site's `rate_limits` table, an upsert (and a delete
// of the minute before) on every call: the most of what a busy site wrote to
// its database, each written through SQLite's WAL to the disk, for counts
// that only last a minute. Kept here, an object that restarts (a deploy, a
// statement the runtime stopped, an idle object put away) starts its minute's
// counts again, letting through at most one more minute's worth; the reads
// limiter and the wrong-password counts have always been kept this way.
//
// A call counts whether or not it then succeeds: a stored count was undone
// with a failed call's transaction, so a run of failing calls was never
// limited. And it counts against all its limits or none: a call refused by
// one (the site's, say) does not spend the others, as a refusal's rollback
// had it.

/** A limit a call counts against: its key, and the calls it allows a minute. */
export type Limit = readonly [key: string, maximum: number];

export class MinuteCounts {
  private minute = 0;
  private counts = new Map<string, number>();

  /**
   * Counts a call against each of `limits` in the minute `now` falls in,
   * unless one is spent: then counts none, and answers that limit's key.
   */
  take(limits: readonly Limit[], now = Date.now()): string | null {
    const minute = Math.floor(now / 60000);
    if (minute !== this.minute) {
      this.minute = minute;
      this.counts = new Map();
    }
    for (const [key, maximum] of limits)
      if ((this.counts.get(key) ?? 0) >= maximum) return key;
    for (const [key] of limits)
      this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    return null;
  }

  /** Forgets every count, as a site replaced whole starts again. */
  clear() {
    this.counts = new Map();
  }
}
