/**
 * A SPARQL console over the node's `/sparql` endpoint: a query editor
 * preloaded with the prefixes, example queries, and results as a table with
 * shortened IRIs (or N-Triples for CONSTRUCT and DESCRIBE). Queries are sent
 * as they are, so every query form works.
 *
 * @module
 */
import { Play } from "lucide-preact";
import { useState } from "preact/hooks";
import { getAuthorization } from "../lib/auth.ts";
import { formatCount } from "../lib/format.ts";
import { ownerPubkey } from "../lib/node.ts";
import { routeForNip19 } from "../lib/nostr.ts";
import { Link } from "../lib/router.tsx";
import { PREFIXES, pubkeyTerm } from "../lib/sparql.ts";
import { Button } from "./Button.tsx";

/** One example query. `owner` is the owner's hex key, when there is one. */
interface Example {
  id: string;
  label: string;
  /** The query body, without prefixes. */
  build: (owner: string) => string;
  /** Whether the example needs the owner to exist. */
  needsOwner: boolean;
}

/** The example queries. Each is checked against docs/DATA-MODEL.md. */
const EXAMPLES: readonly Example[] = [
  {
    id: "notes",
    label: "Latest notes, with author names",
    needsOwner: false,
    build: () =>
      `SELECT ?note ?content ?name ?createdAt WHERE {
  ?note nostr:kind 1 ;
        nostr:createdAt ?createdAt ;
        nostr:author ?author ;
        nostr:content ?content .
  FILTER NOT EXISTS { ?note nostr:replyTo ?parent }
  FILTER NOT EXISTS { ?note nostr:deletedBy ?deletion }
  OPTIONAL {
    ?profile nostr:author ?author ; nostr:kind 0 ; nostr:name ?name .
    FILTER NOT EXISTS { ?profile nostr:supersededBy ?newer }
  }
}
ORDER BY DESC(?createdAt)
LIMIT 50`,
  },
  {
    id: "follows",
    label: "Who the people you follow follow",
    needsOwner: true,
    build: (owner) =>
      `SELECT ?friend ?followed ?followedName WHERE {
  ?own nostr:author ${
        pubkeyTerm(owner)
      } ; nostr:kind 3 ; nostr:follows ?friend .
  FILTER NOT EXISTS { ?own nostr:supersededBy ?newOwn }
  ?list nostr:author ?friend ; nostr:kind 3 ; nostr:follows ?followed .
  FILTER NOT EXISTS { ?list nostr:supersededBy ?newList }
  OPTIONAL {
    ?profile nostr:author ?followed ; nostr:kind 0 ; nostr:name ?followedName .
    FILTER NOT EXISTS { ?profile nostr:supersededBy ?newer }
  }
}
LIMIT 200`,
  },
  {
    id: "articles",
    label: "Articles and their versions",
    needsOwner: false,
    build: () =>
      `SELECT ?article ?version ?title ?createdAt ?current WHERE {
  ?version nostr:kind 30023 ;
           nostr:address ?article ;
           nostr:createdAt ?createdAt .
  FILTER NOT EXISTS { ?version nostr:deletedBy ?deletion }
  BIND(NOT EXISTS { ?version nostr:supersededBy ?newer } AS ?current)
  OPTIONAL { ?version nostr:title ?title }
}
ORDER BY ?article DESC(?createdAt)
LIMIT 100`,
  },
  {
    id: "reactions",
    label: "Most reacted-to notes",
    needsOwner: false,
    build: () =>
      `SELECT ?note ?content (COUNT(DISTINCT ?reaction) AS ?reactions) WHERE {
  ?reaction nostr:reactsTo ?note .
  FILTER NOT EXISTS { ?reaction nostr:deletedBy ?deletion }
  OPTIONAL { ?note nostr:content ?content }
}
GROUP BY ?note ?content
ORDER BY DESC(?reactions)
LIMIT 20`,
  },
  {
    id: "kinds",
    label: "Events per kind",
    needsOwner: false,
    build: () =>
      `SELECT ?kind (COUNT(?event) AS ?events) WHERE {
  ?event nostr:kind ?kind .
}
GROUP BY ?kind
ORDER BY DESC(?events)`,
  },
  {
    id: "relays",
    label: "Events first seen per relay",
    needsOwner: false,
    build: () =>
      `SELECT ?relay (COUNT(?event) AS ?events) WHERE {
  ?event nostr:seenOn ?relay .
}
GROUP BY ?relay
ORDER BY DESC(?events)`,
  },
  {
    id: "blobs",
    label: "Blobs and who uploaded them",
    needsOwner: false,
    build: () =>
      `SELECT ?blob ?type ?size ?uploader WHERE {
  ?receipt nostr:blob ?blob ;
           nostr:uploadedBy ?uploader .
  FILTER NOT EXISTS { ?receipt nostr:removedAt ?removed }
  OPTIONAL { ?blob nostr:blobType ?type }
  OPTIONAL { ?blob nostr:blobSize ?size }
}
LIMIT 100`,
  },
  {
    id: "profiles",
    label: "Superseded profile versions",
    needsOwner: false,
    build: () =>
      `SELECT ?author ?old ?new WHERE {
  ?old nostr:kind 0 ;
       nostr:author ?author ;
       nostr:supersededBy ?new .
}
ORDER BY ?author
LIMIT 100`,
  },
];

/** The text the console starts with. */
const STARTER = EXAMPLES[0].build("");

/** Rows shown at most; a larger result is cut and says so. */
const ROW_LIMIT = 500;

/** One SPARQL JSON term, as the endpoint returns it. */
interface Term {
  type: string;
  value: string;
  datatype?: string;
}

type Result =
  | {
    kind: "table";
    vars: string[];
    rows: Record<string, Term | undefined>[];
    total: number;
    ms: number;
  }
  | { kind: "ask"; value: boolean; ms: number }
  | { kind: "text"; body: string; ms: number }
  | { kind: "error"; message: string; status: number };

/** A readable form of a long IRI: the start and the end, the rest elided. */
export function shortIri(value: string): string {
  if (value.length <= 40) return value;
  return `${value.slice(0, 22)}…${value.slice(-10)}`;
}

/** A term in a result cell: links for NIP-19 identifiers, else plain text. */
function Cell({ term }: { term: Term | undefined }) {
  if (!term) return <span class="muted">–</span>;
  const isIri = term.type === "uri";
  const text = isIri ? shortIri(term.value) : term.value;
  if (isIri) {
    const to = routeForNip19(term.value);
    if (to) {
      return <Link to={to} class="mono" title={term.value}>{text}</Link>;
    }
    return <span class="mono" title={term.value}>{text}</span>;
  }
  return <span title={term.value}>{text}</span>;
}

/** Props of {@link SparqlConsole}. */
export interface SparqlConsoleProps {
  /** Initial query text; defaults to the first example. */
  initial?: string;
}

/** The query editor, examples and results. */
export function SparqlConsole({ initial = STARTER }: SparqlConsoleProps) {
  const [query, setQuery] = useState(PREFIXES + "\n" + initial);
  const [result, setResult] = useState<Result>();
  const [running, setRunning] = useState(false);
  const owner = ownerPubkey.value;
  const examples = EXAMPLES.filter((e) => !e.needsOwner || owner);

  const run = async () => {
    setRunning(true);
    const started = performance.now();
    const ms = () => Math.round(performance.now() - started);
    try {
      const text = query;
      const send = (authorization?: string) =>
        fetch("/sparql", {
          method: "POST",
          headers: {
            "content-type": "application/sparql-query",
            accept:
              "application/sparql-results+json, application/n-triples;q=0.9",
            ...(authorization ? { authorization } : {}),
          },
          body: text,
        });
      let response = await send();
      if (response.status === 401 || response.status === 403) {
        const auth = await getAuthorization("/sparql", "POST", text);
        if (auth) response = await send(auth);
      }
      const body = await response.text();
      if (!response.ok) {
        setResult({
          kind: "error",
          message: body.trim() || `HTTP ${response.status}`,
          status: response.status,
        });
      } else if (
        (response.headers.get("content-type") ?? "").includes("sparql-results")
      ) {
        const json = JSON.parse(body) as {
          head?: { vars?: string[] };
          boolean?: boolean;
          results?: { bindings: Record<string, Term>[] };
        };
        if (typeof json.boolean === "boolean") {
          setResult({ kind: "ask", value: json.boolean, ms: ms() });
        } else {
          const bindings = json.results?.bindings ?? [];
          setResult({
            kind: "table",
            vars: json.head?.vars ?? [],
            rows: bindings.slice(0, ROW_LIMIT),
            total: bindings.length,
            ms: ms(),
          });
        }
      } else {
        setResult({ kind: "text", body, ms: ms() });
      }
    } catch (error) {
      setResult({
        kind: "error",
        message: `Node unreachable: ${(error as Error).message}`,
        status: 0,
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div class="sparql">
      <div class="sparql__toolbar">
        <label class="sparql__examples">
          <span class="field__label">Examples</span>
          <select
            class="field__input"
            value=""
            onChange={(e) => {
              const id = (e.target as HTMLSelectElement).value;
              const example = examples.find((x) => x.id === id);
              if (!example || !owner) return;
              setQuery(PREFIXES + "\n" + example.build(owner));
              setResult(undefined);
            }}
          >
            <option value="" disabled>Choose a query…</option>
            {examples.map((example) => (
              <option key={example.id} value={example.id}>
                {example.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label class="field">
        <span class="field__label">Query</span>
        <textarea
          class="sparql__input"
          spellcheck={false}
          rows={12}
          value={query}
          aria-describedby="sparql-hint"
          onInput={(e) => setQuery((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void run();
            }
          }}
        />
      </label>
      <div class="row sparql__actions">
        <Button
          variant="primary"
          icon={<Play size={16} />}
          loading={running}
          onClick={() => void run()}
        >
          Run
        </Button>
        <span id="sparql-hint" class="muted sparql__hint">
          Ctrl/Cmd+Enter runs the query. Only queries are accepted.
        </span>
      </div>
      {result && <SparqlResult result={result} />}
    </div>
  );
}

/** The outcome of a run: table, boolean, N-Triples text or error. */
function SparqlResult({ result }: { result: Result }) {
  if (result.kind === "error") {
    return (
      <div class="sparql__result">
        <p class="form-error" role="alert">
          Error {result.status ? `(HTTP ${result.status})` : ""}
        </p>
        <pre class="sparql__text">{result.message}</pre>
      </div>
    );
  }
  if (result.kind === "ask") {
    return (
      <div class="sparql__result">
        <p class="muted">Answer in {result.ms} ms</p>
        <p class="sparql__boolean">{result.value ? "true" : "false"}</p>
      </div>
    );
  }
  if (result.kind === "text") {
    const lines = result.body.split("\n").filter(Boolean).length;
    return (
      <div class="sparql__result">
        <p class="muted">
          {formatCount(lines)} triples in {result.ms} ms
        </p>
        <pre class="sparql__text">{result.body}</pre>
      </div>
    );
  }
  return (
    <div class="sparql__result">
      <p class="muted" aria-live="polite">
        {formatCount(result.total)} {result.total === 1 ? "row" : "rows"} in
        {" "}
        {result.ms} ms
        {result.total > ROW_LIMIT && ` (showing the first ${ROW_LIMIT})`}
      </p>
      {result.rows.length > 0 && (
        <div class="sparql__table-wrap">
          <table class="sparql__table">
            <thead>
              <tr>
                {result.vars.map((v) => <th key={v} scope="col">?{v}</th>)}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                <tr key={i}>
                  {result.vars.map((v) => (
                    <td key={v}>
                      <Cell term={row[v]} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
