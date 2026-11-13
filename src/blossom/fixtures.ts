/**
 * Shared test helpers for the Blossom tests: signed authorizations, a server
 * over an in-memory graph and a temporary data directory.
 * @module
 */
import { createHash } from "node:crypto";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "@nostr/tools/pure";
import { encodeBase64 } from "@std/encoding/base64";
import { MemoryTripleStore, staticGraph, testConfig } from "../testing/mod.ts";
import type { BlossomServer, Config } from "../types.ts";
import { createBlossomServer } from "./mod.ts";

/** A key pair that can sign authorizations. */
export interface Signer {
  secretKey: Uint8Array;
  pubkey: string;
}

export function newSigner(): Signer {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKey(secretKey) };
}

/** The lower-case hex SHA-256 of some bytes. */
export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Options for a test authorization event. */
export interface AuthOptions {
  /** Values of the `x` tags. */
  hashes?: string[];
  /** Unix seconds; defaults to an hour from now. */
  expiration?: number;
  /** Unix seconds; defaults to now. */
  createdAt?: number;
  /** Defaults to 24242. */
  kind?: number;
}

/** An `Authorization` header value for an action. */
export function authorization(
  who: Signer,
  action: string,
  options: AuthOptions = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const tags: string[][] = [
    ["t", action],
    ["expiration", String(options.expiration ?? now + 3600)],
    ...(options.hashes ?? []).map((hash) => ["x", hash]),
  ];
  const event = finalizeEvent({
    kind: options.kind ?? 24242,
    created_at: options.createdAt ?? now,
    tags,
    content: `${action} blob`,
  }, who.secretKey);
  return `Nostr ${encodeBase64(JSON.stringify(event))}`;
}

/** A test server and everything it runs on. */
export interface Fixture {
  server: BlossomServer;
  config: Config;
  triples: MemoryTripleStore;
  /** The temporary data directory; blobs live in `<dataDir>/blobs`. */
  dataDir: string;
}

/**
 * Run a test against a fresh server. `members` maps pubkeys to their distance
 * from the owner; the temporary data directory is removed afterwards.
 */
export async function withFixture(
  members: Record<string, number>,
  test: (fixture: Fixture) => Promise<void>,
  overrides: Partial<Config> = {},
): Promise<void> {
  const dataDir = await Deno.makeTempDir();
  const config = testConfig({ dataDir, ...overrides });
  const triples = new MemoryTripleStore();
  const server = createBlossomServer({
    triples,
    graph: staticGraph(members),
    config,
  });
  try {
    await test({ server, config, triples, dataDir });
  } finally {
    await Deno.remove(dataDir, { recursive: true });
  }
}

/** The file names in the blob directory of a data directory. */
export async function blobDirEntries(dataDir: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(`${dataDir}/blobs`)) {
      names.push(entry.name);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return names.sort();
}
