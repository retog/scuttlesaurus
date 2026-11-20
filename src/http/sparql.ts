/**
 * The SPARQL 1.1 Protocol endpoint at `/sparql`: queries only. Updates are
 * refused because the graph is written only through events. Contract:
 * `docs/ARCHITECTURE.md`, "SPARQL endpoint".
 *
 * Query problems are answered with plain text, as SPARQL clients expect. The
 * owner-authorization errors and the method check use the JSON format of the
 * rest of the API.
 * @module
 */
import { clientAddress, noteLimitReached } from "../client_address.ts";
import { type Node, QueryLimitError } from "../types.ts";
import { ClientBudget } from "./client_budget.ts";
import { authorizeOwner } from "./nip98.ts";
import { MAX_QUERY, NO_BODY, readBody } from "./body.ts";
import {
  HttpError,
  messageOf,
  methodNotAllowed,
  plainText,
} from "./respond.ts";

/** A request to `/sparql`, read as far as its parameters go. */
interface SparqlRequest {
  /** The request body, kept for NIP-98 payload checks. */
  body: Uint8Array;
  /** The query text, as sent; undefined when none was given. */
  query: string | undefined;
  /** Whether an `update` parameter was given. */
  update: boolean;
}

/** One budget per node, created by its first request. */
const budgets = new WeakMap<Node, ClientBudget>();

/**
 * Answer a request to `/sparql`: `GET ?query=…`, `POST` with the query as the
 * body (`application/sparql-query`), or `POST` with a form that has a `query`
 * field (`application/x-www-form-urlencoded`).
 */
export async function handleSparql(
  node: Node,
  request: Request,
  budget?: ClientBudget,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return methodNotAllowed(["GET", "POST"]);
  }
  const config = node.configManager.config;
  try {
    const sparql = await readRequest(request);
    if (!config.publicSparql) {
      const owner = await authorizeOwner(request, config, sparql.body);
      if (typeof owner !== "string") return owner;
    }
    const query = checkQuery(sparql);
    if (!budget) {
      budget = budgets.get(node);
      if (!budget) budgets.set(node, budget = new ClientBudget());
    }
    return await run(node, query, request, budget);
  } catch (error) {
    if (error instanceof HttpError) {
      return plainText(error.status, error.message);
    }
    throw error;
  }
}

/**
 * Read the query and the `update` parameter from a request.
 *
 * @throws {HttpError} 400 for an update media type, 413 for a body that is too
 *   large, 415 for a body type the endpoint does not take.
 */
async function readRequest(request: Request): Promise<SparqlRequest> {
  const url = new URL(request.url);
  if (request.method === "GET") {
    return {
      body: NO_BODY,
      query: url.searchParams.get("query") ?? undefined,
      update: url.searchParams.has("update"),
    };
  }

  const type = mediaType(request.headers.get("content-type"));
  if (type === "application/sparql-update") throw readOnly();
  if (
    type !== "application/sparql-query" &&
    type !== "application/x-www-form-urlencoded"
  ) {
    throw new HttpError(
      415,
      "send the query as application/sparql-query or as a form field",
    );
  }

  const body = await readBody(request, MAX_QUERY);
  const text = new TextDecoder().decode(body);
  if (type === "application/sparql-query") {
    return {
      body,
      query: text,
      update: url.searchParams.has("update"),
    };
  }
  const form = new URLSearchParams(text);
  return {
    body,
    query: form.get("query") ?? undefined,
    update: form.has("update") || url.searchParams.has("update"),
  };
}

/**
 * The trimmed query text, checked for the cases the endpoint refuses.
 *
 * @throws {HttpError} 400 for an update or a missing query, 413 for a query
 *   that is too large.
 */
function checkQuery(sparql: SparqlRequest): string {
  if (sparql.update) throw readOnly();
  const query = sparql.query?.trim() ?? "";
  if (query === "") {
    throw new HttpError(400, "missing query: send one in the query parameter");
  }
  if (new TextEncoder().encode(query).byteLength > MAX_QUERY) {
    throw new HttpError(413, "the query is too large");
  }
  return query;
}

/**
 * Evaluate the query. Every query here is untrusted, whoever sent it, so the
 * store bounds it and the client's budget bounds how much of the store one
 * address can take. A query the store rejects is a 400 with its message; one
 * that ran out of time is a 503; one the store has no capacity for is a 503
 * with `Retry-After`; one from an address that is over its budget is a 429
 * with `Retry-After`, and never reaches the store.
 */
async function run(
  node: Node,
  query: string,
  request: Request,
  budget: ClientBudget,
): Promise<Response> {
  const client = clientAddress(request);
  let ran = true;
  let ticket;
  try {
    ticket = budget.admit(client);
    const result = await node.events.triples.query(query, {
      untrusted: true,
      client,
      onStart: ticket.start,
    });
    return new Response(result.body, {
      headers: {
        "Content-Type": result.contentType,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof QueryLimitError) {
      ran = error.reason !== "busy" && error.reason !== "budget";
      const budgeted = error.reason === "budget";
      if (budgeted) noteLimitReached(request);
      const response = plainText(budgeted ? 429 : 503, error.message);
      if (error.reason !== "timeout") {
        response.headers.set("Retry-After", String(error.retryAfter ?? 5));
      }
      return response;
    }
    return plainText(400, messageOf(error));
  } finally {
    ticket?.finish(ran);
  }
}

/** The media type of a `Content-Type` header, lower-cased, without parameters. */
function mediaType(header: string | null): string {
  return header?.split(";")[0].trim().toLowerCase() ?? "";
}

function readOnly(): HttpError {
  return new HttpError(
    400,
    "this endpoint is read-only: send a query, not an update",
  );
}
