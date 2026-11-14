/**
 * The node API under `/api/`: status, social graph, first-run setup and the
 * owner's settings. Contract: `docs/ARCHITECTURE.md`, "Node API".
 * @module
 */
import type {
  ConfigPatch,
  Node,
  ReplicationConfig,
  StoreStats,
} from "../types.ts";
import { authorizeOwner } from "./nip98.ts";
import {
  isRecord,
  MAX_JSON_BODY,
  NO_BODY,
  parseJsonObject,
  readBody,
} from "./body.ts";
import { cachedStats, graphDocument, statusDocument } from "./status.ts";
import {
  errorResponse,
  HttpError,
  jsonResponse,
  messageOf,
  methodNotAllowed,
} from "./respond.ts";

/** What the API handlers share: the node and the caches and locks they use. */
export interface ApiContext {
  node: Node;
  /** Store statistics, cached for a few seconds. */
  stats: () => Promise<StoreStats>;
  /** Runs tasks one after another; used so that setup happens once. */
  serialize: <T>(task: () => Promise<T>) => Promise<T>;
}

/** An endpoint: the handler for one path and method. */
type Endpoint = (context: ApiContext, request: Request) => Promise<Response>;

/** The API's paths, and the endpoint for each method. */
const ENDPOINTS = new Map<string, Partial<Record<string, Endpoint>>>([
  ["/api/status", { GET: getStatus }],
  ["/api/graph", { GET: getGraph }],
  ["/api/setup", { POST: postSetup }],
  ["/api/config", { GET: getConfig, PUT: putConfig }],
]);

/** Create the shared state of the API for a node. */
export function createApiContext(node: Node): ApiContext {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    node,
    stats: cachedStats(node.events),
    serialize<T>(task: () => Promise<T>): Promise<T> {
      const run = queue.then(task);
      queue = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}

/**
 * Answer a request whose path is under `/api/`. Unknown paths are 404 and
 * known paths with another method are 405.
 */
export function handleApi(
  context: ApiContext,
  request: Request,
  path: string,
): Promise<Response> {
  const methods = ENDPOINTS.get(path);
  if (methods === undefined) {
    return Promise.resolve(errorResponse(404, "no such API endpoint"));
  }
  const endpoint = methods[request.method];
  if (endpoint === undefined) {
    return Promise.resolve(methodNotAllowed(Object.keys(methods)));
  }
  return endpoint(context, request);
}

/** `GET /api/status`: the public status of the node. */
async function getStatus(
  context: ApiContext,
  request: Request,
): Promise<Response> {
  return jsonResponse(
    await statusDocument(context.node, request, context.stats),
  );
}

/** `GET /api/graph`: the owner's social graph with each author's distance. */
function getGraph(context: ApiContext): Promise<Response> {
  const config = context.node.configManager.config;
  return Promise.resolve(jsonResponse(graphDocument(config, context.node)));
}

/**
 * `POST /api/setup` with `{ "owner": "<npub or hex>" }`. Works once: the owner
 * is set only while the node has none.
 */
async function postSetup(
  context: ApiContext,
  request: Request,
): Promise<Response> {
  const { node } = context;
  if (node.configManager.config.owner !== undefined) {
    throw new HttpError(409, "the node already has an owner");
  }
  const body = parseJsonObject(await readBody(request, MAX_JSON_BODY));
  const owner = body.owner;
  if (typeof owner !== "string") {
    throw new HttpError(400, "owner must be an npub or a hex public key");
  }

  return await context.serialize(async () => {
    if (node.configManager.config.owner !== undefined) {
      throw new HttpError(409, "the node already has an owner");
    }
    try {
      await node.configManager.update({ owner });
    } catch (error) {
      throw new HttpError(400, messageOf(error));
    }
    return jsonResponse(await statusDocument(node, request, context.stats));
  });
}

/** `GET /api/config` (owner): the changeable settings and the locked ones. */
async function getConfig(
  context: ApiContext,
  request: Request,
): Promise<Response> {
  const { configManager } = context.node;
  const owner = await authorizeOwner(request, configManager.config, NO_BODY);
  if (typeof owner !== "string") return owner;
  return jsonResponse(configDocument(context));
}

/**
 * `PUT /api/config` (owner) with a `ConfigPatch`. The values are checked by the
 * configuration; a rejected value or a locked setting is a 400.
 */
async function putConfig(
  context: ApiContext,
  request: Request,
): Promise<Response> {
  const { configManager } = context.node;
  const body = await readBody(request, MAX_JSON_BODY);
  const owner = await authorizeOwner(request, configManager.config, body);
  if (typeof owner !== "string") return owner;

  const patch = toPatch(parseJsonObject(body));
  try {
    await configManager.update(patch);
  } catch (error) {
    throw new HttpError(400, messageOf(error));
  }
  return jsonResponse(configDocument(context));
}

/** The settings document of `GET` and `PUT /api/config`. */
function configDocument(context: ApiContext): unknown {
  const { configManager } = context.node;
  const config = configManager.config;
  return {
    settings: {
      owner: config.owner ?? null,
      name: config.name,
      description: config.description,
      publicUrl: config.publicUrl ?? null,
      replication: config.replication,
    },
    locked: [...configManager.locked].sort(),
  };
}

/**
 * Narrow a JSON object to a `ConfigPatch`. Only the known keys are taken, and
 * their JSON types are checked here. The configuration checks the values.
 *
 * @throws {HttpError} 400 when a key has the wrong JSON type.
 */
function toPatch(source: Record<string, unknown>): ConfigPatch {
  const patch: ConfigPatch = {};
  for (const key of ["owner", "name", "description", "publicUrl"] as const) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw new HttpError(400, `${key} must be a string`);
    }
    patch[key] = value;
  }
  const replication = source.replication;
  if (replication !== undefined) {
    if (!isRecord(replication)) {
      throw new HttpError(400, "replication must be an object");
    }
    // Each field is checked by the configuration when the patch is applied.
    patch.replication = replication as Partial<ReplicationConfig>;
  }
  return patch;
}
