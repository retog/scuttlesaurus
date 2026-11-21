/**
 * The web client: files from `web/dist/`, and `index.html` for the client's
 * own routes. Contract: `docs/ARCHITECTURE.md`, "HTTP surface".
 * @module
 */
import { serveDir, serveFile } from "@std/http/file-server";
import { fromFileUrl, join } from "@std/path";
import { errorResponse, plainText, withHeaders } from "./respond.ts";

/** The built web client, `web/dist/` beside `src/`. */
export const DEFAULT_WEB_DIR = fromFileUrl(
  new URL("../../web/dist", import.meta.url),
);

/** The message for a node whose web client has not been built. */
const NOT_BUILT = "The web client has not been built. Run `deno task build`.";

/**
 * Serve a `GET` or `HEAD` request from the web directory. A path that is not a
 * file is answered with `index.html` when the client accepts HTML, so that the
 * client can route it; otherwise it is a 404. Files are never cached, because
 * the build does not fingerprint their names.
 *
 * @param webDir The directory with the built client.
 */
export async function serveWebClient(
  request: Request,
  webDir: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(404, "not found");
  }
  const pathname = new URL(request.url).pathname;

  if (!pathname.endsWith("/") && isSafePath(pathname)) {
    const file = await serveDir(request, {
      fsRoot: webDir,
      quiet: true,
      showDirListing: false,
      showIndex: false,
    });
    if (file.status !== 404) return noCache(file);
    await file.body?.cancel();
  }

  if (looksLikeFile(pathname) || !acceptsHtml(request)) {
    return errorResponse(404, "not found");
  }
  const index = join(webDir, "index.html");
  if (!(await isFile(index))) return plainText(503, NOT_BUILT);
  return noCache(await serveFile(request, index));
}

/**
 * Whether a URL path can name a file inside the web directory: it has no `..`
 * segment, no backslash and no NUL once decoded.
 */
function isSafePath(pathname: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return false;
  return !decoded.split("/").includes("..");
}

/**
 * Whether the request accepts an HTML document. Clients that state no
 * preference (no `Accept` header, or a wildcard) do.
 */
function acceptsHtml(request: Request): boolean {
  const accept = request.headers.get("accept")?.toLowerCase();
  return accept === undefined || accept.includes("text/html") ||
    accept.includes("*/*");
}

/**
 * Whether the last path segment has a file extension. Such a path names an
 * asset, never a route of the web client, so a missing one is a 404.
 */
function looksLikeFile(pathname: string): boolean {
  return /\.[A-Za-z0-9]+$/.test(pathname.slice(pathname.lastIndexOf("/") + 1));
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/** A copy of a static response that the browser must revalidate. */
function noCache(response: Response): Response {
  return withHeaders(response, { "Cache-Control": "no-cache" });
}
