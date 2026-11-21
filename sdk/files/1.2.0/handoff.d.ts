/**
 * Naru's builder handoff: a website that makes someone's Naru site (a
 * builder) hands Naru the files, and the site's owner reviews and approves
 * them on Naru.
 *
 * ```js
 * import { propose, photo } from "https://sdk.naru.pub/sdk/1.2.0/handoff.js";
 *
 * button.onclick = async () => {
 *   const result = await propose({
 *     title: "내 홈페이지",
 *     files: [{ path: "index.html", data: html }, { path: "photo.jpg", data: blob }],
 *   });
 *   // { applied: true, url } once the owner approves; { applied: false } if not
 * };
 * ```
 *
 * Call `propose` from a click: on the web it opens Naru in a popup, where the
 * owner signs in, sees what would change and approves. In the Naru apps it
 * hands the files to the app, which does the same. Naru records where the
 * files came from as the browser or the app reports it, never as the page
 * says.
 *
 * @packageDocumentation
 */

/** One file of the site. */
export interface ProposedFile {
  /** Its path in the site (or under `target`), such as `"index.html"`. */
  path: string;
  /** Text, or bytes. */
  data: string | Blob | ArrayBuffer | ArrayBufferView;
}

export interface Proposal {
  /** What the owner sees it as, such as `"소개 페이지"`. */
  title?: string;
  /** A folder of the owner's site to put the files in, such as `"blog/"`; the site's root if left out. */
  target?: string;
  files: ProposedFile[];
}

/** The owner's answer: applied, with the site's address, or not. */
export type ProposalResult =
  { applied: true; url: string } | { applied: false };

/**
 * Hands the files to Naru for the owner to review and approve. Resolves once
 * they decide, or close Naru's window; rejects only when there is nothing to
 * hand over or the browser blocked the popup.
 */
export declare function propose(proposal: Proposal): Promise<ProposalResult>;

/**
 * A photo as a website shows it: at most `max` pixels (1600) on the long
 * side, upright, re-encoded (JPEG, or PNG for PNG, GIF and WebP, which may
 * be transparent), so it carries no metadata, location included.
 */
export declare function photo(file: Blob, max?: number): Promise<Blob>;
