/**
 * The share target of the installed web client (`share_target` in
 * `web/static/manifest.webmanifest`). The client's service worker answers
 * `POST /share` itself and keeps shared files; this handler is the fallback for
 * a browser that posts before the service worker controls the page. It keeps
 * the title, text and URL and redirects to the client's share view.
 * @module
 */
import { readBody } from "./body.ts";

/** Path the manifest names as the share target's action. */
export const SHARE_PATH = "/share";

/** Largest share form read here; larger ones carry files, which are dropped. */
export const MAX_SHARE_BODY = 256 * 1024;

/** The fields of a share that the client view reads from its query. */
const FIELDS = ["title", "text", "url"] as const;

/**
 * Answer a shared form with a `303` to `/share?title=…&text=…&url=…`. Files are
 * not kept; `files=dropped` tells the view that some were left behind.
 */
export async function receiveShare(request: Request): Promise<Response> {
  const target = new URLSearchParams();
  try {
    const body = await readBody(request, MAX_SHARE_BODY);
    const form = await new Request(request.url, {
      method: "POST",
      headers: { "content-type": request.headers.get("content-type") ?? "" },
      body: body as Uint8Array<ArrayBuffer>,
    }).formData();
    for (const field of FIELDS) {
      const value = form.get(field);
      if (typeof value === "string" && value.trim() !== "") {
        target.set(field, value);
      }
    }
    if (form.getAll("files").some((f) => typeof f !== "string" && f.size)) {
      target.set("files", "dropped");
    }
  } catch {
    // Too large or not a form: what was shared cannot be read here.
    target.set("files", "dropped");
  }
  const query = target.toString();
  return new Response(null, {
    status: 303,
    headers: { Location: SHARE_PATH + (query ? `?${query}` : "") },
  });
}
