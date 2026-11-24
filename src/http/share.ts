/**
 * The share target of the installed web client (`share_target` in
 * `web/static/manifest.webmanifest`). The client's service worker answers
 * `POST /share` itself and keeps shared files; this handler is the fallback for
 * a browser that posts before the service worker controls the page. It keeps
 * the title, text and URL and redirects to the client's share view.
 * @module
 */

/** Path the manifest names as the share target's action. */
export const SHARE_PATH = "/share";

/**
 * How much of a shared form is read here. A larger one carries files, which
 * are dropped; the text fields come before them and are still kept.
 */
export const MAX_SHARE_BODY = 256 * 1024;

/** The fields of a share that the client view reads from its query. */
const FIELDS = ["title", "text", "url"] as const;
type Field = typeof FIELDS[number];

/**
 * Answer a shared form with a `303` to `/share?title=…&text=…&url=…`. Files are
 * not kept; `files=dropped` tells the view that some were left behind.
 */
export async function receiveShare(request: Request): Promise<Response> {
  const target = new URLSearchParams();
  const contentType = request.headers.get("content-type") ?? "";
  const { bytes, complete } = await readPrefix(request, MAX_SHARE_BODY);
  let fields: Map<Field, string>;
  let dropped = !complete;
  if (complete) {
    try {
      const form = await new Request(request.url, {
        method: "POST",
        headers: { "content-type": contentType },
        body: bytes as Uint8Array<ArrayBuffer>,
      }).formData();
      fields = new Map();
      for (const field of FIELDS) {
        const value = form.get(field);
        if (typeof value === "string") fields.set(field, value);
      }
      dropped = form.getAll("files").some((f) =>
        typeof f !== "string" && f.size > 0
      );
    } catch {
      fields = new Map();
    }
  } else {
    fields = textFieldsOfPrefix(bytes, contentType);
  }
  for (const field of FIELDS) {
    const value = fields.get(field);
    if (value !== undefined && value.trim() !== "") target.set(field, value);
  }
  if (dropped) target.set("files", "dropped");
  const query = target.toString();
  return new Response(null, {
    status: 303,
    headers: { Location: SHARE_PATH + (query ? `?${query}` : "") },
  });
}

/**
 * Read at most `limit` bytes of the body. `complete` is false when the body
 * went on; the rest is not read.
 */
async function readPrefix(
  request: Request,
  limit: number,
): Promise<{ bytes: Uint8Array; complete: boolean }> {
  if (request.body === null) {
    return { bytes: new Uint8Array(0), complete: true };
  }
  const reader = request.body.getReader();
  const bytes = new Uint8Array(limit);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { bytes: bytes.subarray(0, length), complete: true };
      const room = limit - length;
      bytes.set(value.subarray(0, room), length);
      length += Math.min(room, value.byteLength);
      if (value.byteLength > room) {
        await reader.cancel();
        return { bytes, complete: false };
      }
    }
  } catch {
    return { bytes: bytes.subarray(0, length), complete: false };
  }
}

/**
 * The text fields among the parts of a multipart form that lie wholly inside
 * `prefix`, the first bytes of a body too large to read. Parts with a file
 * name, and the part cut off by the end of the prefix, are skipped.
 */
export function textFieldsOfPrefix(
  prefix: Uint8Array,
  contentType: string,
): Map<Field, string> {
  const fields = new Map<Field, string>();
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/i);
  if (!/^multipart\/form-data/i.test(contentType) || !boundary) return fields;
  // One character per byte, so the text of a part maps back to its bytes.
  let text = "";
  for (let i = 0; i < prefix.length; i += 8192) {
    text += String.fromCharCode(...prefix.subarray(i, i + 8192));
  }
  const delimiter = `--${boundary[1] ?? boundary[2]}`;
  const parts = text.split(delimiter);
  // The first piece is the preamble, the last one may be cut off.
  for (const part of parts.slice(1, -1)) {
    const split = part.indexOf("\r\n\r\n");
    if (split < 0) continue;
    const headers = part.slice(0, split);
    const disposition = headers.match(
      /content-disposition:\s*form-data;([^\r\n]*)/i,
    )?.[1];
    if (!disposition || /\bfilename\*?=/i.test(disposition)) continue;
    const name = disposition.match(/\bname="([^"]*)"/i)?.[1];
    if (!name || !(FIELDS as readonly string[]).includes(name)) continue;
    const body = part.slice(split + 4).replace(/\r\n$/, "");
    const raw = Uint8Array.from(body, (c) => c.charCodeAt(0));
    fields.set(name as Field, new TextDecoder().decode(raw));
  }
  return fields;
}
