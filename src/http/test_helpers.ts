/**
 * Helpers for the HTTP tests: a node built from the real parts (configuration,
 * event store, relay, Blossom) over an in-memory graph, a temporary web
 * directory, and signing for events and NIP-98 authorizations.
 * @module
 */
import { encodeBase64 } from "@std/encoding/base64";
import { encodeHex } from "@std/encoding/hex";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "@nostr/tools/pure";
import { loadConfig } from "../config.ts";
import { openEventStore } from "../store/mod.ts";
import { createRelayServer } from "../relay/mod.ts";
import { createBlossomServer } from "../blossom/mod.ts";
import { MemoryTripleStore, staticGraph } from "../testing/mod.ts";
import type { EventStore, Node, NostrEvent, Replicator } from "../types.ts";
import { createHttpHandler } from "./mod.ts";

/** A running test node with its handler and the directories it uses. */
export interface Fixture {
  node: Node;
  events: EventStore;
  handler: (request: Request) => Promise<Response>;
  /** The temporary directory holding the data and web directories. */
  root: string;
  /** Removes the temporary directory and closes the node's stores. */
  close(): Promise<void>;
}

/** Options for {@link makeFixture}. */
export interface FixtureOptions {
  /** Environment for the configuration; `DATA_DIR` is set for you. */
  env?: Record<string, string>;
  /** Social distances of the in-memory graph. */
  distances?: Record<string, number>;
  /** Whether the web directory holds a built client; default true. */
  built?: boolean;
}

/** A key pair for signing. */
export interface Signer {
  secretKey: Uint8Array;
  pubkey: string;
}

/** Create a node for a test. */
export async function makeFixture(
  options: FixtureOptions = {},
): Promise<Fixture> {
  const root = await Deno.makeTempDir({ prefix: "scuttle-http-" });
  const dataDir = `${root}/data`;
  const webDir = `${root}/web`;
  await Deno.mkdir(webDir);
  if (options.built !== false) {
    await Deno.writeTextFile(
      `${webDir}/index.html`,
      "<!doctype html><title>client</title>",
    );
    await Deno.mkdir(`${webDir}/assets`);
    await Deno.writeTextFile(`${webDir}/assets/app.js`, "console.log(1);\n");
  }

  const configManager = await loadConfig({
    REPLICATION: "off",
    ...options.env,
    DATA_DIR: dataDir,
  });
  const config = configManager.config;
  const triples = new MemoryTripleStore();
  const events = await openEventStore(triples, config);
  const graph = staticGraph(options.distances ?? {});
  const replicator: Replicator = {
    start() {},
    stop: () => Promise.resolve(),
    status: () => ({
      enabled: false,
      running: false,
      authorsByHop: [],
      relays: [],
    }),
    publish: () => Promise.resolve([]),
  };
  const relay = createRelayServer({ events, graph, config });
  const node: Node = {
    configManager,
    events,
    graph,
    replicator,
    relay,
    blossom: createBlossomServer({ triples, graph, config }),
  };
  return {
    node,
    events,
    handler: createHttpHandler(node, webDir),
    root,
    async close() {
      relay.close();
      await events.close();
      await Deno.remove(root, { recursive: true });
    },
  };
}

/** A fresh key pair. */
export function newSigner(): Signer {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKey(secretKey) };
}

/** A signed event of the given kind, created now unless told otherwise. */
export function signEvent(
  signer: Signer,
  kind: number,
  content = "",
  tags: string[][] = [],
  createdAt = Math.floor(Date.now() / 1000),
): NostrEvent {
  return finalizeEvent(
    { kind, created_at: createdAt, tags, content },
    signer.secretKey,
  );
}

/** The `Authorization` header value for a NIP-98 event. */
export function nip98Header(event: NostrEvent): string {
  const json = new TextEncoder().encode(JSON.stringify(event));
  return `Nostr ${encodeBase64(json)}`;
}

/** Options for {@link nip98Event}. */
export interface Nip98Options {
  createdAt?: number;
  /** The `u` tag; defaults to the request's URL. */
  url: string;
  /** The `method` tag; defaults to GET. */
  method?: string;
  /** The `payload` tag, when given. */
  payload?: string;
}

/** A NIP-98 authorization event signed by `signer`. */
export function nip98Event(signer: Signer, options: Nip98Options): NostrEvent {
  const tags = [
    ["u", options.url],
    ["method", options.method ?? "GET"],
  ];
  if (options.payload !== undefined) tags.push(["payload", options.payload]);
  return signEvent(
    signer,
    27235,
    "",
    tags,
    options.createdAt ?? Math.floor(Date.now() / 1000),
  );
}

/** The lower-case hex SHA-256 of some bytes. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return encodeHex(new Uint8Array(digest));
}

/** Read a JSON response body, asserting the status. */
export async function jsonOf(
  response: Response,
  status: number,
): Promise<unknown> {
  const text = await response.text();
  if (response.status !== status) {
    throw new Error(`expected ${status}, got ${response.status}: ${text}`);
  }
  return JSON.parse(text);
}
