/**
 * The single HTTP entry point: relay, NIP-11, SPARQL, API, NIP-05, Blossom and
 * the web client on one port. Contract: `docs/ARCHITECTURE.md`, "HTTP surface".
 *
 * The handler never throws. Every response except the WebSocket upgrade and
 * the CORS preflight answer carries the CORS headers.
 * @module
 */
import { rememberClient } from "../client_address.ts";
import type { Node } from "../types.ts";
import { createApiContext } from "./api.ts";
import { preflightResponse, withCorsHeaders } from "./cors.ts";
import { DEFAULT_WEB_DIR } from "./static.ts";
import { route, type RouterContext } from "./router.ts";
import { errorResponse, HttpError } from "./respond.ts";

export { DEFAULT_WEB_DIR } from "./static.ts";

/**
 * Create the request handler for a node.
 *
 * @param node The node whose relay, graph, Blossom server and configuration
 *   serve the requests.
 * @param webDir The directory with the built web client; defaults to
 *   `web/dist/` beside `src/`. Tests pass their own.
 */
export function createHttpHandler(
  node: Node,
  webDir: string = DEFAULT_WEB_DIR,
): (request: Request, info?: Deno.ServeHandlerInfo) => Promise<Response> {
  const context: RouterContext = {
    node,
    webDir,
    api: createApiContext(node),
  };
  return async (request, info) => {
    rememberClient(request, info?.remoteAddr);
    if (request.method === "OPTIONS") return preflightResponse();
    const response = await answer(request, context);
    // The WebSocket upgrade response is returned untouched.
    return response.status === 101 ? response : withCorsHeaders(response);
  };
}

/** Route a request; any error becomes a JSON error response. */
async function answer(
  request: Request,
  context: RouterContext,
): Promise<Response> {
  try {
    return await route(request, context);
  } catch (error) {
    if (error instanceof HttpError) {
      return errorResponse(error.status, error.message, error.headers);
    }
    console.error("http: unexpected error", error);
    return errorResponse(500, "internal server error");
  }
}
