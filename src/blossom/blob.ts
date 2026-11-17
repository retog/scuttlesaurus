/**
 * Blob identity and the blob descriptor of BUD-02, and the public base URL it
 * is built on.
 * @module
 */
import { extension } from "@std/media-types";
import { externalBase } from "../base_url.ts";
import type { Config } from "../types.ts";

/** The media type of a blob whose type is not known. */
export const DEFAULT_MEDIA_TYPE = "application/octet-stream";

/** A blob's identity: the lower-case hex SHA-256 of its bytes. */
export function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/** A hex public key, as used in `GET /list/<pubkey>`. */
export function isPubkey(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/** A blob descriptor, as returned by upload and list (BUD-02). */
export interface BlobDescriptor {
  url: string;
  sha256: string;
  size: number;
  type: string;
  /** Unix seconds. */
  uploaded: number;
}

/**
 * The base URL of blob descriptors (BUD-02): the node's external base URL, by
 * the same rules as the rest of the node (see `externalBase`). Read at each
 * call, since the configuration can change at runtime.
 */
export function publicBase(config: Config, request: Request): string {
  return externalBase(request, config);
}

/**
 * The blob descriptor (BUD-02). The URL carries the usual extension of the
 * media type, when there is one.
 * @param base The base URL from {@link publicBase}.
 */
export function describeBlob(
  base: string,
  sha256: string,
  size: number,
  type: string,
  uploaded: number,
): BlobDescriptor {
  const ext = extension(type);
  return {
    url: `${base}/${sha256}${ext ? `.${ext}` : ""}`,
    sha256,
    size,
    type,
    uploaded,
  };
}
