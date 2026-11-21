/**
 * Recognizing the form of a SPARQL query without parsing it, so that the
 * right result format can be requested and updates can be refused.
 *
 * @module
 */

/** The four query forms of SPARQL 1.1. */
export type QueryForm = "SELECT" | "ASK" | "CONSTRUCT" | "DESCRIBE";

const PROLOGUE =
  /^(?:\s+|#[^\n]*(?:\n|$)|PREFIX\s+[^\s:]*:\s*<[^>]*>|BASE\s*<[^>]*>)/i;

/**
 * The form of a SPARQL query, found by skipping whitespace, comments and the
 * `PREFIX` / `BASE` prologue. Throws for anything that is not a query, in
 * particular for updates such as `INSERT` or `DELETE`.
 */
export function queryForm(sparql: string): QueryForm {
  let rest = sparql;
  for (let m = PROLOGUE.exec(rest); m; m = PROLOGUE.exec(rest)) {
    rest = rest.slice(m[0].length);
  }
  const keyword = /^[A-Za-z]+/.exec(rest)?.[0].toUpperCase();
  if (
    keyword === "SELECT" || keyword === "ASK" || keyword === "CONSTRUCT" ||
    keyword === "DESCRIBE"
  ) {
    return keyword;
  }
  throw new Error(
    "Only SPARQL queries (SELECT, ASK, CONSTRUCT, DESCRIBE) are allowed",
  );
}

/** The result media type of a query form. */
export function resultType(form: QueryForm): string {
  return form === "CONSTRUCT" || form === "DESCRIBE"
    ? "application/n-triples"
    : "application/sparql-results+json";
}
