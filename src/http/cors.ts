/**
 * Cross-origin headers. Every response is readable from any origin, and
 * `OPTIONS` requests get the preflight answer.
 * @module
 */
import { withHeaders } from "./respond.ts";

/** The answer to a CORS preflight request, on any path. */
export function preflightResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "Authorization, Content-Type, X-SHA-256, X-Content-Length, X-Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}

/** A copy of a response that carries the CORS headers of ordinary responses. */
export function withCorsHeaders(response: Response): Response {
  return withHeaders(response, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "*",
  });
}
