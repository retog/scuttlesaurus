/**
 * Uploads: `PUT /upload` stores a blob (BUD-02), `HEAD /upload` tells whether
 * an upload would be accepted (BUD-06). Nothing is stored by the HEAD request.
 * @module
 */
import { createHash } from "node:crypto";
import type { Context } from "./context.ts";
import { authorize, covers } from "./auth.ts";
import { BlossomError } from "./errors.ts";
import {
  DEFAULT_MEDIA_TYPE,
  describeBlob,
  isSha256,
  publicBase,
} from "./blob.ts";
import { mediaTypeOf, parseSize } from "./media.ts";
import {
  blobPath,
  blobsDir,
  exists,
  removeQuietly,
  tempPath,
} from "./storage.ts";
import {
  describeBlobNTriples,
  liveReceipts,
  receiptNTriples,
  storedBlob,
} from "./triples.ts";

const TOO_LARGE = "blob exceeds maxBlobSize";
const NOT_COVERED = "authorization does not name this blob";
const OUTSIDE_GRAPH = "not within the social graph of this server's owner";

/**
 * `PUT /upload` (BUD-02). The body is streamed to a temporary file while it is
 * hashed and counted, so a blob is never held in memory. The file is then
 * moved to `<dataDir>/blobs/<sha256>` and its triples are inserted.
 *
 * @param now Current unix time in seconds.
 */
export async function receiveBlob(
  ctx: Context,
  request: Request,
  now: number,
): Promise<Response> {
  const auth = authorize(request.headers, "upload", now);
  assertMember(ctx, auth.pubkey);
  const max = ctx.config.blossom.maxBlobSize;
  const declared = parseSize(
    request.headers.get("content-length"),
    "Content-Length",
  );
  if (declared !== undefined && declared > max) {
    throw new BlossomError(413, TOO_LARGE);
  }
  const type = mediaTypeOf(request.headers.get("content-type"));
  const base = publicBase(ctx.config, request);

  await Deno.mkdir(blobsDir(ctx.config), { recursive: true });
  const temp = tempPath(ctx.config);
  try {
    const { sha256, size } = await writeBody(request.body, temp, max);
    if (!covers(auth, sha256)) throw new BlossomError(400, NOT_COVERED);
    return await ctx.serialize(() =>
      commitUpload(ctx, {
        temp,
        sha256,
        size,
        type,
        pubkey: auth.pubkey,
        now,
        base,
      })
    );
  } finally {
    // Gone after a successful move; otherwise the upload was refused.
    await removeQuietly(temp);
  }
}

/**
 * `HEAD /upload` (BUD-06). Answers 200 when a `PUT /upload` with the announced
 * hash, size and type would be accepted, and the matching error otherwise.
 */
export function checkUpload(
  ctx: Context,
  request: Request,
  now: number,
): Response {
  const auth = authorize(request.headers, "upload", now);
  const sha256 = request.headers.get("x-sha-256") ?? "";
  if (!isSha256(sha256)) throw new BlossomError(400, "malformed X-SHA-256");
  if (!covers(auth, sha256)) throw new BlossomError(400, NOT_COVERED);
  assertMember(ctx, auth.pubkey);
  const length = parseSize(
    request.headers.get("x-content-length"),
    "X-Content-Length",
  );
  if (length === undefined) {
    throw new BlossomError(400, "missing X-Content-Length");
  }
  if (length > ctx.config.blossom.maxBlobSize) {
    throw new BlossomError(413, TOO_LARGE);
  }
  mediaTypeOf(request.headers.get("x-content-type"));
  return new Response(null, { status: 200 });
}

function assertMember(ctx: Context, pubkey: string): void {
  if (ctx.graph.distance(pubkey) === undefined) {
    throw new BlossomError(403, OUTSIDE_GRAPH);
  }
}

/**
 * Copy the request body to a new file, hashing it on the way. Stops with 413
 * as soon as more than `max` bytes have arrived.
 */
async function writeBody(
  body: ReadableStream<Uint8Array> | null,
  path: string,
  max: number,
): Promise<{ sha256: string; size: number }> {
  const file = await Deno.open(path, { write: true, createNew: true });
  const hash = createHash("sha256");
  let size = 0;
  try {
    if (body !== null) {
      for await (const chunk of body) {
        size += chunk.byteLength;
        if (size > max) throw new BlossomError(413, TOO_LARGE);
        hash.update(chunk);
        await writeAll(file, chunk);
      }
    }
  } catch (error) {
    if (error instanceof BlossomError) throw error;
    throw new BlossomError(400, "request body could not be read");
  } finally {
    file.close();
  }
  return { sha256: hash.digest("hex"), size };
}

async function writeAll(file: Deno.FsFile, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    offset += await file.write(chunk.subarray(offset));
  }
}

/** Move the file into place and record the upload. Runs under the lock. */
async function commitUpload(
  ctx: Context,
  upload: {
    temp: string;
    sha256: string;
    size: number;
    type: string;
    pubkey: string;
    now: number;
    base: string;
  },
): Promise<Response> {
  const { sha256, pubkey, now } = upload;
  const target = blobPath(ctx.config, sha256);
  // An identical blob already on disk is kept; the temporary copy goes.
  if (!(await exists(target))) {
    await Deno.rename(upload.temp, target);
  }

  const stored = await storedBlob(ctx.triples, sha256);
  if (stored === undefined) {
    await ctx.triples.insert(
      describeBlobNTriples(sha256, upload.size, upload.type),
    );
  }
  // The description is the first one recorded for the blob.
  const size = stored?.size ?? upload.size;
  const type = stored === undefined
    ? upload.type
    : stored.type ?? DEFAULT_MEDIA_TYPE;

  const mine = await liveReceipts(ctx.triples, sha256, pubkey);
  let uploaded = now;
  if (mine.length > 0) {
    uploaded = Math.min(...mine.map((receipt) => receipt.uploadedAt));
  } else {
    await ctx.triples.insert(
      receiptNTriples(`urn:uuid:${crypto.randomUUID()}`, sha256, pubkey, now),
    );
  }
  return Response.json(
    describeBlob(upload.base, sha256, size, type, uploaded),
  );
}
