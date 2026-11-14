/**
 * Response helpers shared by the HTTP layer, and the error type handlers throw
 * to answer with a status code. API and error bodies are JSON with
 * `Cache-Control: no-store`; see `docs/ARCHITECTURE.md`, "HTTP surface".
 * @module
 */

/** A failure a handler reports to the client with a status and a message. */
export class HttpError extends Error {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    status: number,
    message: string,
    headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.headers = headers;
  }
}

/** A JSON response that is never cached. */
export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

/** A JSON error body: `{ "error": "<message>" }`. */
export function errorResponse(
  status: number,
  message: string,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return jsonResponse({ error: message }, status, headers);
}

/** A 405 response that names the methods the resource accepts. */
export function methodNotAllowed(allowed: readonly string[]): Response {
  return errorResponse(405, "method not allowed", {
    Allow: allowed.join(", "),
  });
}

/** A plain-text response that is never cached. */
export function plainText(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * A copy of a response with some headers replaced. The body is passed through
 * unchanged, and the copy's headers are mutable even when the original's are
 * not.
 */
export function withHeaders(
  response: Response,
  headers: Readonly<Record<string, string>>,
): Response {
  const copy = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) copy.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: copy,
  });
}

/** The message of an error, or its string form when it is not an Error. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
