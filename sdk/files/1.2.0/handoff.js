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
 *     builder: "homepage",
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

const CONTROL_PLANE = "https://naru.pub";

const toBlob = (data) =>
  data instanceof Blob
    ? data
    : typeof data === "string"
      ? new Blob([data], { type: "text/plain" })
      : new Blob([data]);

const base64 = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

const waiting = new Map();
let androidListening = false;

function appBridge() {
  const scope = globalThis;
  const apple = scope.webkit?.messageHandlers?.naruHandoff;
  if (apple)
    return async (message) =>
      (await apple.postMessage(message)) ?? { applied: false };
  const android = scope.naruHandoff;
  if (android && typeof android.postMessage === "function") {
    if (!androidListening) {
      androidListening = true;
      android.addEventListener("message", (event) => {
        let answer;
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

async function viaApp(bridge, proposal) {
  const files = await Promise.all(
    proposal.files.map(async (file) => ({
      path: file.path,
      base64: await base64(toBlob(file.data)),
    })),
  );
  return bridge({
    id: crypto.randomUUID(),
    builder: proposal.builder,
    title: proposal.title,
    target: proposal.target,
    collections: proposal.collections,
    files,
  });
}

// The web: naru.pub/handoff in a popup says it is ready after every load
// (signing in reloads it), and is sent the files each time.
function viaPopup(proposal) {
  const popup = window.open(
    `${CONTROL_PLANE}/handoff`,
    "naru-handoff",
    "width=480,height=720",
  );
  if (!popup)
    return Promise.reject(new Error("Allow pop-ups to apply to Naru."));
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", listen);
      clearInterval(watch);
      resolve(result);
    };
    function listen(event) {
      if (event.origin !== CONTROL_PLANE || event.source !== popup) return;
      const type = event.data?.type;
      if (type === "naru:ready")
        popup.postMessage(
          {
            type: "naru:files",
            builder: proposal.builder,
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
export function propose(proposal) {
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
export async function photo(file, max = 1600) {
  const image = await createImageBitmap(file, {
    imageOrientation: "from-image",
  });
  const scale = Math.min(1, max / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close();
  const png = /png|gif|webp/.test(file.type);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Could not read the photo.")),
      png ? "image/png" : "image/jpeg",
      0.82,
    ),
  );
}
