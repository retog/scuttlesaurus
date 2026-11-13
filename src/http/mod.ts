/**
 * The single HTTP entry point: relay, NIP-11, SPARQL, API, Blossom and the
 * web client on one port. Contract: `docs/ARCHITECTURE.md`.
 * @module
 */
import type { Node } from "../types.ts";

export function createHttpHandler(
  _node: Node,
): (request: Request) => Promise<Response> {
  throw new Error("not implemented");
}
