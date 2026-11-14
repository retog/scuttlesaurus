/**
 * Typed client for the node's HTTP API (`/api/*`, see ARCHITECTURE.md
 * "Node API"). Owner-only endpoints are authorized with NIP-98.
 *
 * @module
 */
import type { ConfigPatch } from "../../../src/types.ts";
import { getAuthorization } from "./auth.ts";

export type { ConfigPatch };

/** Response of `GET /api/status`. Fields besides the documented core may be absent. */
export interface NodeStatus {
  name: string;
  description: string;
  version: string;
  /** Hex public key of the owner, or `null` while the node is not set up. */
  owner: string | null;
  setupRequired: boolean;
  relayUrl: string;
  publicUrl: string;
  /** Replication depth in follow hops. */
  hops: number;
  publicSparql: boolean;
  /** Whether the Blossom server is enabled. */
  blossom: boolean | { enabled: boolean; [key: string]: unknown };
  /** Counters, e.g. `{ events, triples }`. */
  stats: { events?: number; triples?: number; [key: string]: unknown };
  /** Number of replicated authors per hop distance: `{ "0": 1, "1": 120 }` or `[1, 120]`. */
  authorsByHop: Record<string, number> | number[];
  replication: { enabled?: boolean; [key: string]: unknown };
  connections: { [key: string]: unknown };
}

/** Response of `GET /api/graph`. */
export interface NodeGraph {
  owner: string | null;
  hops: number;
  /** Follow-hop distance from the owner, by hex pubkey. */
  distances: Record<string, number>;
}

/** Response of `GET /api/config`. */
export interface ConfigResponse {
  /** The changeable settings. */
  config: Record<string, unknown>;
  /** Dotted paths (such as `replication.hops`) locked by environment variables. */
  locked: string[];
}

/** An error response from the node. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.auth) {
    const authorization = await getAuthorization(path, method);
    if (!authorization) throw new ApiError("Sign in as the owner first", 401);
    headers.authorization = authorization;
  }
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (error) {
    throw new ApiError(`Node unreachable: ${(error as Error).message}`, 0);
  }
  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
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

/** `POST /api/setup`: make `owner` (npub or hex) the owner; only works once. */
export function setup(owner: string): Promise<{ owner: string }> {
  return request("/api/setup", { method: "POST", body: { owner } });
}

/** `GET /api/config` (owner, NIP-98). */
export function getConfig(): Promise<ConfigResponse> {
  return request("/api/config", { auth: true });
}

/** `PUT /api/config` (owner, NIP-98). */
export function putConfig(patch: ConfigPatch): Promise<unknown> {
  return request("/api/config", { method: "PUT", body: patch, auth: true });
}
