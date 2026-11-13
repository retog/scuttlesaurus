/**
 * Media types of uploads and the header values that carry them.
 * @module
 */
import { BlossomError } from "./errors.ts";
import { DEFAULT_MEDIA_TYPE } from "./blob.ts";

const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

/**
 * The media type to store for a `Content-Type` header value (BUD-02): parameters are
 * dropped, the rest lower-cased. A missing header means
 * `application/octet-stream`. A value that could not be written safely into
 * the graph is refused with 400.
 *
 * @throws {BlossomError} 400 when the header is malformed.
 */
export function mediaTypeOf(header: string | null): string {
  if (header === null) return DEFAULT_MEDIA_TYPE;
  // The type is written as an N-Triples literal, so nothing that needs
  // escaping may pass, even in the parameters that are dropped.
  if (!/^[\x20-\x7e]*$/.test(header) || /["\\<>]/.test(header)) {
    throw new BlossomError(400, "malformed Content-Type");
  }
  const type = header.split(";")[0].trim().toLowerCase();
  if (!MEDIA_TYPE.test(type)) {
    throw new BlossomError(400, "malformed Content-Type");
  }
  return type;
}

/**
 * A non-negative size from a header or query value, or undefined when absent.
 * @throws {BlossomError} 400 when present but not a number of bytes.
 */
export function parseSize(
  value: string | null,
  name: string,
): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new BlossomError(400, `malformed ${name}`);
  }
  return Number(value);
}
