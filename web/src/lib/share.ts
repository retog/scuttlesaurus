/**
 * What the installed app receives as a share target (see `share_target` in
 * `web/static/manifest.webmanifest` and `web/static/sw.js`): the note text
 * made from a shared title, text and link, a Nostr reference among them, and
 * the shared files the service worker kept.
 *
 * @module
 */
import { routeForNip19 } from "./nostr.ts";

/** The text fields of a share, as the `/share` view reads them. */
export interface SharedData {
  title?: string;
  text?: string;
  url?: string;
}

/** Cache the service worker keeps shared files in. */
export const SHARE_CACHE = "scuttlesaurus-share";

const WEB_URL = /\bhttps?:\/\/[^\s<>"']+/i;
const NIP19 =
  /\b(?:nostr:)?(?:npub|nprofile|note|nevent|naddr)1[02-9ac-hj-np-z]{6,}/i;

/** The shared fields from the query of the `/share` view. */
export function sharedFromQuery(query: URLSearchParams): SharedData {
  const get = (key: string) => query.get(key)?.trim() || undefined;
  return { title: get("title"), text: get("text"), url: get("url") };
}

/**
 * The link of a share: the `url` field, or else the first web address in the
 * text, which is where several Android apps put it.
 */
export function sharedLink(data: SharedData): string | undefined {
  return data.url ?? data.text?.match(WEB_URL)?.[0];
}

/**
 * The note text for a share: the title (unless the text already holds it or
 * it only repeats the link), the text, and the link unless the text already
 * holds it, separated by blank lines.
 */
export function composeShared(data: SharedData): string {
  const { title, text, url } = data;
  const parts: string[] = [];
  const link = sharedLink(data);
  if (title && title !== link && !text?.includes(title)) parts.push(title);
  if (text) parts.push(text);
  if (url && !text?.includes(url)) parts.push(url);
  return parts.join("\n\n");
}

/**
 * The in-app path of the first Nostr reference in a share (`npub1…`,
 * `nostr:nevent1…`, also inside a web link such as `https://njump.me/note1…`),
 * or `undefined`.
 */
export function sharedNostrPath(data: SharedData): string | undefined {
  for (const field of [data.url, data.text, data.title]) {
    const match = field?.match(NIP19)?.[0];
    const path = match ? routeForNip19(match) : null;
    if (path) return path;
  }
  return undefined;
}

/**
 * Take the files the service worker kept for the last share, oldest first,
 * and forget them. Empty when there are none or the browser has no caches.
 */
export async function takeSharedFiles(): Promise<File[]> {
  if (!("caches" in globalThis)) return [];
  try {
    if (!(await caches.has(SHARE_CACHE))) return [];
    const cache = await caches.open(SHARE_CACHE);
    const keys = [...(await cache.keys())];
    keys.sort((a, b) => indexOf(a) - indexOf(b));
    const files: File[] = [];
    for (const key of keys) {
      const response = await cache.match(key);
      if (!response) continue;
      const blob = await response.blob();
      const name = decodeURIComponent(
        response.headers.get("x-file-name") ?? `shared-${files.length}`,
      );
      files.push(new File([blob], name, { type: blob.type }));
    }
    await caches.delete(SHARE_CACHE);
    return files;
  } catch {
    return [];
  }
}

function indexOf(request: Request): number {
  return Number(new URL(request.url).pathname.split("/").pop()) || 0;
}
