/**
 * The keys of the seed personas. Each secret key is the SHA-256 of
 * `scuttlesaurus-seed:<handle>`, so the cast is the same on every run.
 *
 * These keys are public demo keys. Anybody can derive them; never use one for
 * anything real.
 * @module
 */
import { createHash } from "node:crypto";
import { getPublicKey } from "@nostr/tools/pure";
import { npubEncode, nsecEncode } from "@nostr/tools/nip19";

/** The key pair of a persona, with its bech32 forms. */
export interface PersonaKey {
  readonly handle: string;
  readonly secretKey: Uint8Array;
  /** Lower-case hex public key. */
  readonly pubkey: string;
  readonly npub: string;
  readonly nsec: string;
}

const cache = new Map<string, PersonaKey>();

/** The key pair of the persona with this handle. Cached. */
export function personaKey(handle: string): PersonaKey {
  const known = cache.get(handle);
  if (known) return known;
  const secretKey = new Uint8Array(
    createHash("sha256").update(`scuttlesaurus-seed:${handle}`).digest(),
  );
  const pubkey = getPublicKey(secretKey);
  const key: PersonaKey = {
    handle,
    secretKey,
    pubkey,
    npub: npubEncode(pubkey),
    nsec: nsecEncode(secretKey),
  };
  cache.set(handle, key);
  return key;
}
