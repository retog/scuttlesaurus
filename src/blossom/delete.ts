/**
 * `DELETE /<sha256>` (BUD-02): the caller gives up its uploads of a blob. The
 * file is removed once no uploader of the blob is left.
 * @module
 */
import type { Context } from "./context.ts";
import { authorize, covers } from "./auth.ts";
import { BlossomError } from "./errors.ts";
import { blobPath, removeQuietly } from "./storage.ts";
import { liveReceipts, removalNTriples } from "./triples.ts";

/**
 * Remove the caller's live receipts of a blob, and the file if no live receipt
 * of anyone is left. Answers 200 with an empty body.
 *
 * @param now Current unix time in seconds.
 * @throws {BlossomError} 401 without a delete authorization for the blob, 404
 *   when the caller has no live upload of it.
 */
export function deleteBlob(
  ctx: Context,
  request: Request,
  sha256: string,
  now: number,
): Promise<Response> {
  const auth = authorize(request.headers, "delete", now);
  if (!covers(auth, sha256)) {
    throw new BlossomError(401, "authorization does not name this blob");
  }
  return ctx.serialize(async () => {
    const own = await liveReceipts(ctx.triples, sha256, auth.pubkey);
    if (own.length === 0) {
      throw new BlossomError(404, "no live upload of this blob by this key");
    }
    await ctx.triples.insert(
      removalNTriples(own.map((receipt) => receipt.receipt), now),
    );
    const remaining = await liveReceipts(ctx.triples, sha256);
    if (remaining.length === 0) {
      await removeQuietly(blobPath(ctx.config, sha256));
    }
    return new Response(null, { status: 200 });
  });
}
