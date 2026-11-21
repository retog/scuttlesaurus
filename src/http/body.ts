/**
 * Reading request bodies: once, with a size limit, as bytes or as a JSON
 * object. Bodies of routes that need them are read here and the bytes are
 * handed on, so that NIP-98 can hash them without reading the stream twice.
 * @module
 */
import { HttpError } from "./respond.ts";

/** Largest JSON body the API accepts, in bytes. */
export const MAX_JSON_BODY = 64 * 1024;

/** Largest SPARQL query the endpoint accepts, in bytes. */
export const MAX_QUERY = 64 * 1024;

/** An empty body, for requests that have none. */
export const NO_BODY = new Uint8Array(0);

/**
 * Read the whole body of a request, refusing bodies larger than `limit`.
 *
 * @throws {HttpError} 413 when the body is larger than `limit`.
 */
export async function readBody(
  request: Request,
  limit: number,
): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) {
    throw new HttpError(413, "request body too large");
  }
  if (request.body === null) return NO_BODY;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new HttpError(413, "request body too large");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Parse a body as a JSON object.
 *
 * @throws {HttpError} 400 when the body is not a JSON object.
 */
export function parseJsonObject(bytes: Uint8Array): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "the body must be JSON");
  }
  if (!isRecord(value)) {
    throw new HttpError(400, "the body must be a JSON object");
  }
  return value;
}

/** Whether a parsed JSON value is a plain object (not an array or null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
