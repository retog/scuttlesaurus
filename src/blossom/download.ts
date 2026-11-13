/**
 * `GET` and `HEAD /<sha256>[.ext]` (BUD-01): the bytes of a blob, with range
 * requests, conditional requests and immutable caching. No authorization.
 * @module
 */
import { serveFile } from "@std/http/file-server";
import type { Context } from "./context.ts";
import { DEFAULT_MEDIA_TYPE } from "./blob.ts";
import { BlossomError } from "./errors.ts";
import { blobPath, exists } from "./storage.ts";
import { storedBlob } from "./triples.ts";

const UNKNOWN_BLOB = "unknown blob";

/**
 * Serve a blob. The file extension in the URL is ignored. The stored media
 * type is sent; `serveFile` supplies ranges, validators and the length.
 *
 * @throws {BlossomError} 404 when the blob is not stored.
 */
export async function serveBlob(
  ctx: Context,
  request: Request,
  sha256: string,
): Promise<Response> {
  const path = blobPath(ctx.config, sha256);
  if (!(await exists(path))) throw new BlossomError(404, UNKNOWN_BLOB);

  const stored = await storedBlob(ctx.triples, sha256);
  const served = await serveFile(request, path);
  if (served.status === 404) {
    await served.body?.cancel();
    throw new BlossomError(404, UNKNOWN_BLOB);
  }

  const headers = served.headers;
  headers.set("Content-Type", stored?.type ?? DEFAULT_MEDIA_TYPE);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  const { status, statusText } = served;
  if (request.method === "HEAD") {
    await served.body?.cancel();
    return new Response(null, { status, statusText, headers });
  }
  return new Response(served.body, { status, statusText, headers });
}
