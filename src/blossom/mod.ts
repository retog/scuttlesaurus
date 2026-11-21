/**
 * The Blossom blob server: BUD-01 (retrieval), BUD-02 (upload, list, delete)
 * and BUD-06 (upload requirements check). Blob bytes are files in
 * `<dataDir>/blobs/`; their descriptions and upload receipts are triples.
 * Contract: `docs/ARCHITECTURE.md`; data: `docs/DATA-MODEL.md`.
 * @module
 */
import type {
  BlossomServer,
  Config,
  SocialGraph,
  TripleStore,
} from "../types.ts";
import { type Context, createSerializer, nowSeconds } from "./context.ts";
import { errorResponse } from "./errors.ts";
import { deleteBlob } from "./delete.ts";
import { serveBlob } from "./download.ts";
import { listBlobs } from "./list.ts";
import { checkUpload, receiveBlob } from "./upload.ts";

/** What the Blossom server is built from; see `main.ts`. */
export interface BlossomServerOptions {
  triples: TripleStore;
  graph: SocialGraph;
  config: Config;
}

/**
 * Create the Blossom server (BUD-01, BUD-02, BUD-06). `handle` returns `null`
 * for every request that is not a Blossom request, for `OPTIONS`, and always
 * while `config.blossom.enabled` is false.
 */
export function createBlossomServer(
  options: BlossomServerOptions,
): BlossomServer {
  const ctx: Context = {
    triples: options.triples,
    graph: options.graph,
    config: options.config,
    serialize: createSerializer(),
  };
  return {
    handle: (request) => handle(ctx, request),
  };
}

/** The Blossom requests, as the routing function classifies them. */
type Route =
  | { kind: "blob"; sha256: string }
  | { kind: "delete"; sha256: string }
  | { kind: "upload" }
  | { kind: "checkUpload" }
  | { kind: "list"; pubkey: string };

const BLOB_PATH = /^\/([0-9a-f]{64})(\.[A-Za-z0-9]+)?$/;
const LIST_PATH = /^\/list\/([^/]+)$/;

/** Classify a request by method and path; undefined if it is not Blossom's. */
function route(method: string, path: string): Route | undefined {
  if (path === "/upload") {
    if (method === "PUT") return { kind: "upload" };
    if (method === "HEAD") return { kind: "checkUpload" };
    return undefined;
  }
  const list = LIST_PATH.exec(path);
  if (list !== null) {
    return method === "GET" ? { kind: "list", pubkey: list[1] } : undefined;
  }
  const blob = BLOB_PATH.exec(path);
  if (blob === null) return undefined;
  const sha256 = blob[1];
  if (method === "GET" || method === "HEAD") return { kind: "blob", sha256 };
  // DELETE takes the bare hash, as BUD-02 defines it.
  if (method === "DELETE" && blob[2] === undefined) {
    return { kind: "delete", sha256 };
  }
  return undefined;
}

async function handle(
  ctx: Context,
  request: Request,
): Promise<Response | null> {
  if (!ctx.config.blossom.enabled) return null;
  const url = new URL(request.url);
  const found = route(request.method, url.pathname);
  if (found === undefined) return null;
  try {
    return await dispatch(ctx, request, url, found);
  } catch (error) {
    return errorResponse(error);
  }
}

function dispatch(
  ctx: Context,
  request: Request,
  url: URL,
  found: Route,
): Response | Promise<Response> {
  switch (found.kind) {
    case "blob":
      return serveBlob(ctx, request, found.sha256);
    case "delete":
      return deleteBlob(ctx, request, found.sha256, nowSeconds());
    case "upload":
      return receiveBlob(ctx, request, nowSeconds());
    case "checkUpload":
      return checkUpload(ctx, request, nowSeconds());
    case "list":
      return listBlobs(ctx, request, found.pubkey, url);
  }
}
