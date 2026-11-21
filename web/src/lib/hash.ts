/**
 * SHA-256 without the Web Crypto API.
 *
 * `crypto.subtle` only exists in secure contexts (https, or localhost). A node
 * on a home network is often opened as `http://192.168.…`, where signing a
 * request body or an upload would otherwise fail, so hashing is done in plain
 * JavaScript with the library the Nostr primitives already bundle.
 *
 * @module
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/** Lower-case hex SHA-256 of bytes, or of a string's UTF-8 encoding. */
export function sha256Hex(data: Uint8Array | string): string {
  const bytes = typeof data === "string"
    ? new TextEncoder().encode(data)
    : data;
  return bytesToHex(sha256(bytes));
}
