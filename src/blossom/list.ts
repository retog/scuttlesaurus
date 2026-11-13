/**
 * `GET /list/<pubkey>` (BUD-02): the descriptors of the blobs a pubkey has
 * uploaded and not removed. No authorization.
 * @module
 */
import type { Context } from "./context.ts";
import {
  DEFAULT_MEDIA_TYPE,
  describeBlob,
  isPubkey,
  publicBase,
} from "./blob.ts";
import { BlossomError } from "./errors.ts";
import { parseSize } from "./media.ts";
import { listLiveBlobs } from "./triples.ts";

/**
 * Answer with a JSON array of descriptors, newest first. `since` and `until`
 * (unix seconds, inclusive) bound the upload time.
 *
 * @throws {BlossomError} 400 for a malformed pubkey, `since` or `until`.
 */
export async function listBlobs(
  ctx: Context,
  request: Request,
  pubkey: string,
  url: URL,
): Promise<Response> {
  if (!isPubkey(pubkey)) throw new BlossomError(400, "malformed pubkey");
  const since = parseSize(url.searchParams.get("since"), "since");
  const until = parseSize(url.searchParams.get("until"), "until");
  const rows = await listLiveBlobs(ctx.triples, pubkey, { since, until });
  const base = publicBase(ctx.config, request);
  return Response.json(
    rows.map((row) =>
      describeBlob(
        base,
        row.sha256,
        row.size,
        row.type ?? DEFAULT_MEDIA_TYPE,
        row.uploadedAt,
      )
    ),
  );
}
