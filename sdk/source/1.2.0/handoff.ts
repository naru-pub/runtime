/**
 * Naru's maker handoff: a website that makes someone's Naru site (a
 * maker) hands Naru the files, and the site's owner reviews and approves
 * them on Naru.
 *
 * ```js
 * import { propose, photo } from "https://sdk.naru.pub/sdk/1.2.0/handoff.js";
 *
 * button.onclick = async () => {
 *   const result = await propose({
 *     maker: "homepage",
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

/**
 * A Naru Data collection the maker's pages use, as the site's
 * `_naru/collections.json` declares one.
 */
export interface CollectionSettings {
  /** Who can read its documents: the owner only, or anyone. */
  read: "admin" | "world";
  /** Who can write: the owner only, anyone adding new documents, or anyone. */
  write: "admin" | "create" | "world";
  /** Up to three fields no two documents may share. */
  unique?: string[];
  /** Up to five fields reads filter on often, each given an index. */
  indexes?: string[];
}

export interface Proposal {
  /**
   * Which maker this is, when one website holds several, such as
   * `"profile"`: lowercase letters, digits and single hyphens, up to 40.
   * Naru tells makers apart by their origin and this name, so one maker
   * replaces only what it wrote itself, and keeps a copy of the rest.
   */
  maker?: string;
  /** What the owner sees it as, such as `"소개 페이지"`. */
  title?: string;
  /** A folder of the owner's site to put the files in, such as `"blog/"`; the site's root if left out. */
  target?: string;
  /**
   * The collections its pages use, by name, such as
   * `{ guestbook: { read: "world", write: "create" } }`. Naru merges them
   * into the site's `_naru/collections.json`, shows the owner what they
   * create or change, and applies them with the files. Left out, the site's
   * collections stay as they are; a collection this maker declared before
   * and leaves out of an object it sends (`{}` for all) is taken out of the
   * file, never deleted with its documents.
   */
  collections?: Record<string, CollectionSettings>;
  files: ProposedFile[];
}

/** The owner's answer: applied, with the site's address, or not. */
export type ProposalResult = { applied: true; url: string } | { applied: false };

const CONTROL_PLANE = "https://naru.pub";

const toBlob = (data: ProposedFile["data"]): Blob =>
  data instanceof Blob
    ? data
    : typeof data === "string"
      ? new Blob([data], { type: "text/plain" })
      : new Blob([data as BlobPart]);

const base64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

interface AppMessage {
  id: string;
  maker?: string;
  title?: string;
  target?: string;
  collections?: Record<string, CollectionSettings>;
  files: { path: string; base64: string }[];
}

// The Naru apps' web views. Apple's answers the message itself; Android's
// web message listener answers with { id, ...result }.
interface AppleHandler {
  postMessage(message: AppMessage): Promise<ProposalResult> | undefined;
}
interface AndroidListener {
  postMessage(message: string): void;
  addEventListener(type: "message", listener: (event: { data: string }) => void): void;
}
type Bridge = (message: AppMessage) => Promise<ProposalResult>;

const waiting = new Map<string, (result: ProposalResult) => void>();
let androidListening = false;

function appBridge(): Bridge | null {
  const scope = globalThis as {
    webkit?: { messageHandlers?: { naruHandoff?: AppleHandler } };
    naruHandoff?: AndroidListener;
  };
  const apple = scope.webkit?.messageHandlers?.naruHandoff;
  if (apple)
    return async (message) =>
      (await apple.postMessage(message)) ?? { applied: false };
  const android = scope.naruHandoff;
  if (android && typeof android.postMessage === "function") {
    if (!androidListening) {
      androidListening = true;
      android.addEventListener("message", (event) => {
        let answer: { id?: unknown; applied?: unknown; url?: unknown };
        try {
          answer = JSON.parse(event.data);
        } catch {
          return;
        }
        const resolve = waiting.get(String(answer.id));
        if (!resolve) return;
        waiting.delete(String(answer.id));
        resolve(
          answer.applied === true && typeof answer.url === "string"
            ? { applied: true, url: answer.url }
            : { applied: false },
        );
      });
    }
    return (message) =>
      new Promise((resolve) => {
        waiting.set(message.id, resolve);
        android.postMessage(JSON.stringify(message));
      });
  }
  return null;
}

async function viaApp(bridge: Bridge, proposal: Proposal) {
  const files = await Promise.all(
    proposal.files.map(async (file) => ({
      path: file.path,
      base64: await base64(toBlob(file.data)),
    })),
  );
  return bridge({
    id: crypto.randomUUID(),
    maker: proposal.maker,
    title: proposal.title,
    target: proposal.target,
    collections: proposal.collections,
    files,
  });
}

// The web: naru.pub/handoff in a popup says it is ready after every load
// (signing in reloads it), and is sent the files each time.
function viaPopup(proposal: Proposal) {
  const popup = window.open(
    `${CONTROL_PLANE}/handoff`,
    "naru-handoff",
    "width=480,height=720",
  );
  if (!popup)
    return Promise.reject(new Error("Allow pop-ups to apply to Naru."));
  return new Promise<ProposalResult>((resolve) => {
    let done = false;
    const finish = (result: ProposalResult) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", listen);
      clearInterval(watch);
      resolve(result);
    };
    function listen(event: MessageEvent) {
      if (event.origin !== CONTROL_PLANE || event.source !== popup) return;
      const type = event.data?.type;
      if (type === "naru:ready")
        popup!.postMessage(
          {
            type: "naru:files",
            maker: proposal.maker,
            title: proposal.title,
            target: proposal.target,
            collections: proposal.collections,
            files: proposal.files,
          },
          CONTROL_PLANE,
        );
      else if (type === "naru:applied" && typeof event.data.url === "string")
        finish({ applied: true, url: event.data.url });
      else if (type === "naru:cancelled") finish({ applied: false });
    }
    window.addEventListener("message", listen);
    const watch = setInterval(() => {
      if (popup.closed) finish({ applied: false });
    }, 500);
  });
}

/**
 * Hands the files to Naru for the owner to review and approve. Resolves once
 * they decide, or close Naru's window; rejects only when there is nothing to
 * hand over or the browser blocked the popup.
 */
export function propose(proposal: Proposal): Promise<ProposalResult> {
  if (!proposal || !Array.isArray(proposal.files) || !proposal.files.length)
    return Promise.reject(new TypeError("No files to propose."));
  const bridge = appBridge();
  return bridge ? viaApp(bridge, proposal) : viaPopup(proposal);
}

/**
 * A photo as a website shows it: at most `max` pixels (1600) on the long
 * side, upright, re-encoded (JPEG, or PNG for PNG, GIF and WebP, which may
 * be transparent), so it carries no metadata, location included.
 */
export async function photo(file: Blob, max = 1600): Promise<Blob> {
  const image = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, max / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close();
  const png = /png|gif|webp/.test(file.type);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not read the photo."))),
      png ? "image/png" : "image/jpeg",
      0.82,
    ),
  );
}
