// How long a site object may serve visitors without hearing from the control
// plane (site.ts's `configure`, sent by its edge sync every few minutes with
// a date some days ahead), held in the object's memory and written to its
// database only when the written one falls a day behind.
//
// It was written on every sync: each site with data committed a transaction
// through SQLite's WAL every few minutes for a date that only ever moved
// forward, the most of what the sites' databases wrote to the disk while
// nobody used them. Held here, an object that restarts (a deploy, an idle
// object put away) reads the written date, at most a day older than the last
// sync's: a site whose control plane stopped answering then serves until a
// day sooner than it would have, never later.

/** How far the written confirmation may fall behind the latest sync's. */
export const CONFIRMATION_WRITE_LAG_MS = 24 * 3_600_000;

export class Confirmation {
  private latest: number | null = null;

  /** Until when visitors may be served: the latest sync's date, or `written`'s. */
  until(written: number): number {
    return this.latest ?? written;
  }

  /**
   * Takes a sync's date; answers whether it has to be written: when it is a
   * day past the written one, or earlier than it (the control plane moved it
   * back, which takes effect at once and must survive a restart).
   */
  take(confirmedUntil: number, written: number): boolean {
    this.latest = confirmedUntil;
    return (
      confirmedUntil < written ||
      confirmedUntil - written > CONFIRMATION_WRITE_LAG_MS
    );
  }
}
