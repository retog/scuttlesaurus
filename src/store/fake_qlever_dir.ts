/**
 * A stand-in for qlever-dir, for tests and CI: an HTTP SPARQL endpoint over an
 * in-process Oxigraph store that, before answering each query, synchronizes
 * with a directory the way qlever-dir does. Every `*.nt` file becomes the
 * named graph `<baseUri + relative path>`, graphs of vanished files are
 * dropped, a file is loaded once and again only when it changes, and queries
 * see the union of all graphs as their default graph. A file that does not
 * parse is replaced by one `urn:qlever-dir:parsingError` triple, as qlever-dir
 * does. Files become visible only after an optional delay, so that waiting for
 * visibility is really exercised.
 *
 * @module
 */
import { join, relative } from "@std/path";
import oxigraph from "oxigraph";
import { escapedGraphIri, PARSING_ERROR } from "./qlever_graph.ts";

/** Options of {@link startFakeQleverDir}. */
export interface FakeQleverDirOptions {
  /** The watched directory. */
  dir: string;
  /** qlever-dir's `BASE_URI` plus the path of `dir` inside its `/data`. */
  baseUri: string;
  /** How long a new or changed file takes to become visible (default 0). */
  delayMs?: number;
}

/** A running fake, with knobs to provoke failures. */
export interface FakeQleverDir {
  /** The endpoint, e.g. `http://127.0.0.1:41234/`. */
  url: string;
  /** Change the visibility delay. */
  setDelay(ms: number): void;
  /** Answer the next `count` requests with `status` instead of evaluating. */
  failNext(count: number, status?: number): void;
  /** Answer every request with 503 until `resume()`, like a starting index. */
  pause(): void;
  resume(): void;
  /** Number of queries received. */
  readonly requests: number;
  /** The graph IRIs currently loaded, sorted. */
  graphs(): string[];
  close(): Promise<void>;
}

/** Start a fake qlever-dir on a free local port. */
export function startFakeQleverDir(
  options: FakeQleverDirOptions,
): FakeQleverDir {
  const store = new oxigraph.Store();
  let delayMs = options.delayMs ?? 0;
  let failures = 0;
  let failStatus = 502;
  let paused = false;
  let requests = 0;
  let changes = 0;
  /** relative path → what was loaded, and when a pending version was seen */
  const loaded = new Map<string, string>();
  const pending = new Map<string, { signature: string; since: number }>();

  async function files(dir: string): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    const walk = async (current: string) => {
      let entries: Deno.DirEntry[] = [];
      try {
        entries = await Array.fromAsync(Deno.readDir(current));
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return;
        throw error;
      }
      for (const entry of entries) {
        const path = join(current, entry.name);
        if (entry.isDirectory) await walk(path);
        else if (entry.isFile && entry.name.endsWith(".nt")) {
          try {
            const info = await Deno.stat(path);
            found.set(
              relative(dir, path).replaceAll("\\", "/"),
              `${info.size}:${info.mtime?.getTime()}`,
            );
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          }
        }
      }
    };
    await walk(dir);
    return found;
  }

  function drop(path: string): void {
    store.update(
      `DROP SILENT GRAPH <${escapedGraphIri(options.baseUri, path)}>`,
    );
    loaded.delete(path);
  }

  async function load(path: string, signature: string): Promise<void> {
    const graph = escapedGraphIri(options.baseUri, path);
    const text = await Deno.readTextFile(join(options.dir, path));
    drop(path);
    try {
      store.load(text, {
        format: "application/n-triples",
        to_graph_name: oxigraph.namedNode(graph),
      });
    } catch (error) {
      store.add(oxigraph.quad(
        oxigraph.namedNode(graph),
        oxigraph.namedNode(PARSING_ERROR),
        oxigraph.literal(String(error)),
        oxigraph.namedNode(graph),
      ));
    }
    loaded.set(path, signature);
    changes++;
  }

  async function sync(): Promise<void> {
    const present = await files(options.dir);
    for (const path of [...loaded.keys()]) {
      if (!present.has(path)) {
        drop(path);
        changes++;
      }
    }
    for (const path of [...pending.keys()]) {
      if (!present.has(path)) pending.delete(path);
    }
    const now = Date.now();
    const before = changes;
    for (const [path, signature] of present) {
      if (loaded.get(path) === signature) continue;
      const seen = pending.get(path);
      if (!seen || seen.signature !== signature) {
        pending.set(path, { signature, since: now });
      }
      if (now - pending.get(path)!.since >= delayMs) {
        pending.delete(path);
        await load(path, signature);
      }
    }
    if (changes !== before) rebuildDefaultGraph();
  }

  /**
   * qlever-dir answers from the union of all graphs with set semantics, which
   * Oxigraph's own union default graph does not provide (it repeats a triple
   * held by two graphs). The default graph is therefore kept as the
   * deduplicated union.
   */
  function rebuildDefaultGraph(): void {
    store.update("DROP SILENT DEFAULT");
    store.update("INSERT { ?s ?p ?o } WHERE { GRAPH ?g { ?s ?p ?o } }");
  }

  // One synchronization at a time, like qlever-dir's single orchestrator.
  let syncing: Promise<void> = Promise.resolve();
  const synchronize = () => (syncing = syncing.then(sync));

  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    async (request) => {
      requests++;
      const body = await request.text();
      if (paused) return new Response("index is building", { status: 503 });
      if (failures > 0) {
        failures--;
        return new Response("injected failure", { status: failStatus });
      }
      try {
        await synchronize();
        const format = request.headers.get("accept") ?? "";
        const result = store.query(body, {
          results_format: format,
        }) as string;
        return new Response(result, { headers: { "content-type": format } });
      } catch (error) {
        return new Response(String(error), { status: 400 });
      }
    },
  );

  return {
    url: `http://127.0.0.1:${server.addr.port}/`,
    setDelay: (ms) => void (delayMs = ms),
    failNext: (count, status = 502) => {
      failures = count;
      failStatus = status;
    },
    pause: () => void (paused = true),
    resume: () => void (paused = false),
    get requests() {
      return requests;
    },
    graphs: () =>
      [...loaded.keys()].map((p) => escapedGraphIri(options.baseUri, p)).sort(),
    close: () => server.shutdown(),
  };
}
