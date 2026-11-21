/**
 * Typed client for the node's HTTP API (`/api/*`, see ARCHITECTURE.md
 * "Node API"). The shapes are the server's: `src/http/status.ts` and
 * `src/http/api.ts`. Owner-only endpoints are authorized with NIP-98.
 *
 * @module
 */
import type {
  ConfigPatch,
  ReplicationConfig,
  ReplicationStatus,
  StoreStats,
} from "../../../src/types.ts";
import { getAuthorization } from "./auth.ts";

export type { ConfigPatch, ReplicationConfig, ReplicationStatus, StoreStats };

/** Response of `GET /api/status` and of `POST /api/setup`. */
export interface NodeStatus {
  name: string;
  description: string;
  version: string;
  /** Hex public key of the owner, or `null` before first-run setup. */
  owner: string | null;
  setupRequired: boolean;
  /** The node's relay URL (`ws[s]://host/`). */
  relayUrl: string;
  /** The external base URL the node is reached at. */
  publicUrl: string;
  /** Configured replication depth, in follow hops. */
  hops: number;
  publicSparql: boolean;
  blossom: { enabled: boolean; maxBlobSize: number };
  stats: StoreStats;
  /** Number of authors at each distance from the owner; index = distance. */
  authorsByHop: number[];
  replication: ReplicationStatus;
  /** Number of open client connections to the relay. */
  connections: number;
}

/** Response of `GET /api/graph`. */
export interface NodeGraph {
  /** Hex public key of the owner, or `null`. */
  owner: string | null;
  hops: number;
  /** Follow-hop distance from the owner, by hex pubkey. */
  distances: Record<string, number>;
}

/** The changeable settings, as `GET` and `PUT /api/config` return them. */
export interface NodeSettings {
  owner: string | null;
  name: string;
  description: string;
  publicUrl: string | null;
  replication: ReplicationConfig;
}

/** Response of `GET /api/config` and of `PUT /api/config`. */
export interface ConfigResponse {
  settings: NodeSettings;
  /** Dotted paths (such as `replication.hops`) set by environment variables. */
  locked: string[];
}

/** An error response from the node, or a failure to reach it (status 0). */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The dotted setting a server validation message is about, e.g.
 * `replication.hops` for `Invalid setting replication.hops 9: …`, or the
 * setting named in `Cannot change name (RELAY_NAME): …`. `undefined` when the
 * message names none.
 */
export function settingOfError(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const match = /^Invalid setting ([\w.]+)/.exec(error.message) ??
    /^Cannot change ([\w.]+)/.exec(error.message);
  return match?.[1];
}

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  const text = init.body === undefined ? undefined : JSON.stringify(init.body);
  if (text !== undefined) headers["content-type"] = "application/json";
  if (init.auth) {
    const authorization = await getAuthorization(path, method, text);
    if (!authorization) throw new ApiError("Sign in with a key first", 401);
    headers.authorization = authorization;
  }
  let response: Response;
  try {
    response = await fetch(path, { method, headers, body: text });
  } catch (error) {
    throw new ApiError(`Node unreachable: ${(error as Error).message}`, 0);
  }
  const answer = await response.text();
  let json: unknown;
  try {
    json = answer ? JSON.parse(answer) : undefined;
  } catch {
    throw new ApiError(
      response.ok
        ? "The node returned something unexpected"
        : `HTTP ${response.status}`,
      response.status,
    );
  }
  if (!response.ok) {
    const message = (json as { error?: string } | undefined)?.error;
    throw new ApiError(message ?? `HTTP ${response.status}`, response.status);
  }
  return json as T;
}

/** `GET /api/status`. */
export function getStatus(): Promise<NodeStatus> {
  return request("/api/status");
}

/** `GET /api/graph`. */
export function getGraph(): Promise<NodeGraph> {
  return request("/api/graph");
}

/**
 * `POST /api/setup`: make `owner` (npub or hex) the owner. Works once; a second
 * attempt is a 409. Resolves with the status after setup.
 */
export function setup(owner: string): Promise<NodeStatus> {
  return request("/api/setup", { method: "POST", body: { owner } });
}

/** `GET /api/config` (owner, NIP-98). */
export function getConfig(): Promise<ConfigResponse> {
  return request("/api/config", { auth: true });
}

/**
 * `PUT /api/config` (owner, NIP-98) with only the settings that change. The
 * server rejects a bad value or a locked setting with a 400.
 */
export function putConfig(patch: ConfigPatch): Promise<ConfigResponse> {
  return request("/api/config", { method: "PUT", body: patch, auth: true });
}
