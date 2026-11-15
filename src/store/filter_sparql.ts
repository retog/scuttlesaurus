/**
 * Translation of NIP-01 filters into SPARQL over the graph of
 * `docs/DATA-MODEL.md`.
 *
 * A filter is *selective* when it names ids, authors or tag values; such a
 * query starts from an index lookup. Any other filter would have to sort all
 * events of a kind, so the event store evaluates it over windows of
 * `nostr:date` values (see {@link buildQuery}'s `dates` option).
 *
 * @module
 */
import type { Filter } from "../types.ts";
import { eventIri, PREFIXES, pubkeyIri } from "../vocab.ts";
import { dateLiteral, integer, iri, literal } from "./ntriples.ts";
import { isHex64 } from "./event_triples.ts";

/** A filter reduced to the well-formed conditions it can be evaluated with. */
export interface ParsedFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  /** Tag letter → accepted values, from `#<letter>` conditions. */
  tags: Map<string, string[]>;
  since?: number;
  until?: number;
  /** Lower-cased NIP-50 search needle. */
  search?: string;
  /** The effective limit, capped by the configured maximum. */
  limit: number;
  /** True when a condition has an empty list, so nothing can match. */
  matchesNothing: boolean;
}

const finite = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n);

/**
 * Clean up a filter: malformed ids, authors and kinds are dropped, a
 * condition left with no values matches nothing, and the limit is capped.
 */
export function parseFilter(filter: Filter, maxLimit: number): ParsedFilter {
  const parsed: ParsedFilter = {
    tags: new Map(),
    limit: Math.floor(Math.min(filter.limit ?? maxLimit, maxLimit)),
    matchesNothing: false,
  };
  const list = (value: unknown): unknown[] | undefined =>
    Array.isArray(value) ? value : undefined;

  const ids = list(filter.ids);
  if (ids) parsed.ids = [...new Set(ids.filter(isHex64))];
  const authors = list(filter.authors);
  if (authors) parsed.authors = [...new Set(authors.filter(isHex64))];
  const kinds = list(filter.kinds);
  if (kinds) {
    parsed.kinds = [
      ...new Set(kinds.filter((k): k is number => Number.isInteger(k))),
    ];
  }
  for (const [key, value] of Object.entries(filter)) {
    if (!/^#[a-zA-Z]$/.test(key)) continue;
    const values = list(value);
    if (!values) continue;
    parsed.tags.set(key[1], [
      ...new Set(
        values.filter((v): v is string =>
          typeof v === "string" && v.isWellFormed()
        ),
      ),
    ]);
  }
  if (finite(filter.since)) parsed.since = filter.since;
  if (finite(filter.until)) parsed.until = filter.until;
  if (typeof filter.search === "string" && filter.search.trim() !== "") {
    parsed.search = filter.search.trim().toLowerCase();
  }
  parsed.matchesNothing = !(parsed.limit > 0) ||
    parsed.ids?.length === 0 || parsed.authors?.length === 0 ||
    parsed.kinds?.length === 0 ||
    [...parsed.tags.values()].some((values) => values.length === 0) ||
    (parsed.since !== undefined && parsed.until !== undefined &&
      parsed.since > parsed.until);
  return parsed;
}

/** Whether the filter can start from an index (ids, authors or a tag value). */
export function isSelective(filter: ParsedFilter): boolean {
  return filter.ids !== undefined || filter.authors !== undefined ||
    filter.tags.size > 0;
}

/** Options of {@link buildQuery}. */
export interface QueryOptions {
  /** Restrict to events of these UTC days (`YYYY-MM-DD`), via `nostr:date`. */
  dates?: string[];
  /** Overrides the filter's own `since` / `until` (used for tie handling). */
  since?: number;
  until?: number;
  /** `events` projects everything needed to rebuild an event; `ids` only `?e`. */
  projection: "events" | "ids";
  /** Number of rows after sorting newest first; omitted for no limit. */
  limit?: number;
}

/**
 * SPARQL for one parsed filter. Superseded and retracted events are excluded.
 * Rows are sorted newest first when a limit is given; the sort within one
 * `created_at` is by IRI and is fixed up by the caller.
 */
export function buildQuery(
  filter: ParsedFilter,
  options: QueryOptions,
): string {
  const since = options.since ?? filter.since;
  const until = options.until ?? filter.until;
  const lines: string[] = [];
  const values = (variable: string, terms: string[]) =>
    lines.push(`VALUES ?${variable} { ${terms.join(" ")} }`);

  if (options.dates) {
    values("date", options.dates.map(dateLiteral));
  }
  if (filter.ids) values("e", filter.ids.map((id) => iri(eventIri(id))));
  if (filter.authors) {
    values("author", filter.authors.map((a) => iri(pubkeyIri(a))));
  }

  lines.push("?e nostr:author ?author ; nostr:kind ?kind ;");
  lines.push("   nostr:createdAt ?createdAt ; nostr:sig ?sig .");
  if (options.dates) lines.push("?e nostr:date ?date .");
  if (options.projection === "events" || filter.search) {
    lines.push("OPTIONAL { ?e nostr:content ?content }");
  }
  if (options.projection === "events") {
    lines.push("OPTIONAL { ?e nostr:tags ?tags }");
  }

  let n = 0;
  for (const [letter, tagValues] of filter.tags) {
    const variable = `tv${n++}`;
    values(variable, tagValues.map(literal));
    lines.push(`?e tag:${letter} ?${variable} .`);
  }

  const filters: string[] = [];
  if (filter.kinds) {
    const kinds = filter.kinds.map(integer);
    filters.push(
      kinds.length === 1
        ? `?kind = ${kinds[0]}`
        : `?kind IN (${kinds.join(", ")})`,
    );
  }
  if (since !== undefined) filters.push(`?createdAt >= ${Math.ceil(since)}`);
  if (until !== undefined) filters.push(`?createdAt <= ${Math.floor(until)}`);
  if (filters.length) lines.push(`FILTER(${filters.join(" && ")})`);
  if (filter.search) {
    lines.push(
      `FILTER(CONTAINS(LCASE(STR(COALESCE(?content, ""))), ${
        literal(filter.search)
      }))`,
    );
  }
  lines.push("MINUS { ?e nostr:deletedBy ?deletion }");
  lines.push("MINUS { ?e nostr:supersededBy ?newer }");

  const select = options.projection === "events"
    ? "SELECT DISTINCT ?e ?author ?kind ?createdAt ?content ?tags ?sig"
    : "SELECT DISTINCT ?e";
  const tail = options.limit !== undefined
    ? `ORDER BY DESC(?createdAt) ?e LIMIT ${options.limit}`
    : "";
  return `${PREFIXES}${select} WHERE {\n${lines.join("\n")}\n}\n${tail}`;
}
