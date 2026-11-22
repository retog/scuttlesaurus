/**
 * The routing function of the HTTP surface. It reads like the table in
 * `docs/ARCHITECTURE.md`, "HTTP surface": the first matching row answers the
 * request, and the last row is the web client.
 * @module
 */
import type { Node } from "../types.ts";
import { type ApiContext, handleApi } from "./api.ts";
import { handleSparql } from "./sparql.ts";
import { nip05Response } from "./nip05.ts";
import { receiveShare, SHARE_PATH } from "./share.ts";
import { serveWebClient } from "./static.ts";

/** What the router is built from: the node, the web directory and API state. */
export interface RouterContext {
  node: Node;
  webDir: string;
  api: ApiContext;
}

/**
 * Answer a request. Responses are not CORS-decorated here; see `mod.ts`. Errors
 * thrown by the handlers propagate to the caller.
 */
export async function route(
  request: Request,
  context: RouterContext,
): Promise<Response> {
  const { node } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const reading = request.method === "GET";

  if (path === "/" && reading && isWebSocketUpgrade(request)) {
    return node.relay.handleUpgrade(request);
  }
  if (path === "/" && reading && wantsNostrJson(request)) {
    return node.relay.info(request);
  }
  if (path === "/sparql") return await handleSparql(node, request);
  if (path === "/api" || path.startsWith("/api/")) {
    return await handleApi(context.api, request, path);
  }
  if (
    path === "/.well-known/nostr.json" &&
    (reading || request.method === "HEAD")
  ) {
    return nip05Response(node.configManager.config, request);
  }
  if (path === SHARE_PATH && request.method === "POST") {
    return await receiveShare(request);
  }
  const blossom = await node.blossom.handle(request);
  if (blossom !== null) return blossom;
  return await serveWebClient(request, context.webDir);
}

/** Whether the request asks to upgrade the connection to a WebSocket. */
function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

/** Whether the client asks for the NIP-11 relay information document. */
function wantsNostrJson(request: Request): boolean {
  return request.headers.get("accept")?.toLowerCase().includes(
    "application/nostr+json",
  ) ?? false;
}
