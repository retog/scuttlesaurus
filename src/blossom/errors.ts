/**
 * Error responses of the Blossom server. Every error carries its reason in an
 * `X-Reason` header, as BUD-01 and BUD-02 leave the body to the server.
 * @module
 */

/** A failure that is reported to the client with a status and a reason. */
export class BlossomError extends Error {
  readonly status: number;
  /** Plain ASCII, sent as the `X-Reason` header. */
  readonly reason: string;

  constructor(status: number, reason: string) {
    super(reason);
    this.name = "BlossomError";
    this.status = status;
    this.reason = reason;
  }
}

/** A response with the given status and reason, and no body. */
export function refusal(status: number, reason: string): Response {
  return new Response(null, { status, headers: { "X-Reason": reason } });
}

/**
 * The response for an error thrown while serving a request. Unexpected errors
 * are logged and answered with 500 so that no internal detail leaks out.
 */
export function errorResponse(error: unknown): Response {
  if (error instanceof BlossomError) {
    return refusal(error.status, error.reason);
  }
  console.error("blossom: unexpected error", error);
  return refusal(500, "internal error");
}
