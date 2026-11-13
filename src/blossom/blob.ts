/**
 * Blob identity and the blob descriptor of BUD-02, and the public base URL it
 * is built on.
 * @module
 */
import { extension } from "@std/media-types";
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
 * The base URL of blob descriptors (BUD-02): `config.publicUrl` if set, otherwise the
 * origin of the request, honouring `X-Forwarded-Proto` and `X-Forwarded-Host`.
 * Read at each call, since the configuration can change at runtime.
 */
export function publicBase(config: Config, request: Request): string {
  if (config.publicUrl) return config.publicUrl.replace(/\/+$/, "");
  const url = new URL(request.url);
  const proto = firstValue(request.headers.get("x-forwarded-proto")) ??
    url.protocol.slice(0, -1);
  const host = firstValue(request.headers.get("x-forwarded-host")) ??
    url.host;
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return url.origin;
  }
}

function firstValue(header: string | null): string | undefined {
  const value = header?.split(",")[0].trim();
  return value ? value : undefined;
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
