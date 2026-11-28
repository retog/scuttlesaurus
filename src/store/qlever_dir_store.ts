/**
 * A {@link TripleStore} on a directory indexed by qlever-dir.
 *
 * qlever-dir turns a directory of RDF files into a read-only SPARQL endpoint:
 * a new file becomes one named graph, applied to the running index within a
 * second or so. This store never sends SPARQL Update. It writes each insert
 * as an immutable N-Triples file, waits until the endpoint shows the file's
 * graph, and queries the endpoint. Old day directories are periodically
 * merged into one file so the number of files stays bounded.
 *
 * @module
 */
import { dirname, join } from "@std/path";
import type {
  InsertOptions,
  QueryOptions,
  StoreConfig,
  TripleStore,
} from "../types.ts";
import { type Backend, tripleStore } from "./backend.ts";
import {
  assertPlausibleNTriples,
  dayPath,
  escapedGraphIri,
  graphIri,
  PARSING_ERROR,
} from "./qlever_graph.ts";
import { SparqlClient } from "./sparql_client.ts";

type QleverConfig = Extract<StoreConfig, { kind: "qlever-dir" }>;

const DAY_MS = 86400_000;
/** Graph IRIs asked about per query when checking existing files. */
const NAME_CHUNK = 300;
/** Version of the state file; other versions are treated as unknown. */
const STATE_VERSION = 1;
/** Names of the batch files this store writes. */
const BATCH_NAME = /^\d+-\d{6}\.nt$/;

/** Tunables of the qlever-dir store; the defaults suit production. */
export interface QleverDirOptions {
  /** How long an insert waits for its file to become visible (default 120 s). */
  visibleTimeoutMs?: number;
  /** First and largest pause between visibility polls (default 50 and 250 ms). */
  pollStartMs?: number;
  pollMaxMs?: number;
  /** How long opening waits for the endpoint to answer (default 10 minutes). */
  openTimeoutMs?: number;
  /** Pause between attempts while opening (default 2 s). */
  openRetryMs?: number;
  /** Time between consolidations (default 6 hours); 0 disables the timer. */
  consolidateEveryMs?: number;
  /** Run a consolidation in the background after opening (default true). */
  consolidateOnOpen?: boolean;
  /** Timeout of a single query request (default 60 s). */
  requestTimeoutMs?: number;
  /**
   * Time limit of a query that came from outside; such a query is never
   * retried (default 10 s).
   */
  untrustedTimeoutMs?: number;
  /**
   * Where to keep `confirmedAt`, the time at which all files were last known
   * to be visible (default none: every open then checks every file). It
   * belongs outside the graph directory, which qlever-dir watches.
   */
  stateFile?: string;
  /**
   * Files whose inode change time is later than `confirmedAt` minus this
   * margin are checked at open (default 2 minutes). The change time has a
   * resolution of one second, and a clock may be a little off, so the margin
   * should stay well above a second; the file written last is always checked
   * again after a restart.
   */
  safetyMarginMs?: number;
  /** Least time between writes of the state file (default 1 minute). */
  stateWriteIntervalMs?: number;
  /** The clock, for naming files and for consolidation (default now). */
  now?: () => Date;
  /** Receives progress and error messages (default `console.warn`). */
  log?: (message: string) => void;
}

/** The qlever-dir store: a {@link TripleStore} that can merge old files. */
export interface QleverDirStore extends TripleStore {
  /**
   * Merge every day directory strictly older than the previous UTC day that
   * holds more than one batch file into `<YYYY>/<MM>/<DD>.nt`, wait until the
   * merged graph is visible, and only then remove the directory. Safe to
   * repeat and to interrupt; calls never overlap.
   */
  consolidate(now?: Date): Promise<void>;
}

/** A day directory holds something other than this store's batch files. */
class ForeignContent extends Error {
  constructor(name: string) {
    super(`${name} is not a batch file`);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class QleverDirBackend implements Backend {
  /** For opening and polling, which have their own retry loops. */
  readonly client: SparqlClient;
  /** For queries from callers, which ride out an index swap. */
  readonly #queries: SparqlClient;
  readonly config: QleverConfig;
  readonly options: Required<QleverDirOptions>;
  #sequence = 0;
  #closed = false;
  #consolidation: Promise<void> = Promise.resolve();
  #timer?: ReturnType<typeof setInterval>;
  /** Write times of this store's files that are not yet confirmed visible. */
  readonly #inFlight = new Set<number>();
  /** A file of ours failed to become visible: stop advancing `confirmedAt`. */
  #failed = false;
  #confirmedAt?: number;
  #persistedAt?: number;
  #lastStateWrite = 0;
  #stateTimer?: ReturnType<typeof setTimeout>;
  #stateChain: Promise<void> = Promise.resolve();

  constructor(config: QleverConfig, options: QleverDirOptions) {
    this.config = config;
    this.options = {
      visibleTimeoutMs: options.visibleTimeoutMs ?? 120_000,
      pollStartMs: options.pollStartMs ?? 50,
      pollMaxMs: options.pollMaxMs ?? 250,
      openTimeoutMs: options.openTimeoutMs ?? 10 * 60_000,
      openRetryMs: options.openRetryMs ?? 2000,
      consolidateEveryMs: options.consolidateEveryMs ?? 6 * 3600_000,
      consolidateOnOpen: options.consolidateOnOpen ?? true,
      requestTimeoutMs: options.requestTimeoutMs ?? 60_000,
      untrustedTimeoutMs: options.untrustedTimeoutMs ?? 10_000,
      stateFile: options.stateFile ?? "",
      safetyMarginMs: options.safetyMarginMs ?? 120_000,
      stateWriteIntervalMs: options.stateWriteIntervalMs ?? 60_000,
      now: options.now ?? (() => new Date()),
      log: options.log ?? ((m) => console.warn(`[qlever-dir] ${m}`)),
    };
    this.client = new SparqlClient(config.queryUrl, {
      timeoutMs: this.options.requestTimeoutMs,
    });
    this.#queries = new SparqlClient(config.queryUrl, {
      timeoutMs: this.options.requestTimeoutMs,
      // qlever-dir answers 502 for a moment when it swaps in a rebuilt index.
      retries: 6,
    });
  }

  /**
   * Create the directory, wait for the endpoint to answer, then wait until
   * every file already in the directory is visible. Files can predate this
   * process: a graph copied from the embedded store, a restored backup, or
   * files written just before a crash. Loading the event ids earlier would
   * silently miss them.
   */
  async open(): Promise<void> {
    await this.#waitForEndpoint();
    await this.#waitForExistingFiles();
  }

  async #waitForEndpoint(): Promise<void> {
    await Deno.mkdir(this.config.graphDir, { recursive: true });
    const { openTimeoutMs, openRetryMs, log } = this.options;
    const deadline = Date.now() + openTimeoutMs;
    let announced = false;
    for (;;) {
      try {
        await this.client.evaluate("ASK {}", "ASK");
        return;
      } catch (error) {
        if (Date.now() >= deadline) {
          throw new Error(
            `qlever-dir at ${this.config.queryUrl} did not answer within ${
              Math.round(openTimeoutMs / 1000)
            } s: ${error instanceof Error ? error.message : error}`,
          );
        }
        if (!announced) {
          announced = true;
          log(
            `waiting for qlever-dir at ${this.config.queryUrl} (it may still be building its first index)`,
          );
        }
        await sleep(openRetryMs);
      }
    }
  }

  /** The persisted `confirmedAt`, or undefined when unknown or unusable. */
  async #readState(): Promise<number | undefined> {
    if (!this.options.stateFile) return undefined;
    try {
      const state = JSON.parse(await Deno.readTextFile(this.options.stateFile));
      if (
        state?.version === STATE_VERSION &&
        state.graphDir === this.config.graphDir &&
        state.baseUri === this.config.baseUri &&
        Number.isFinite(state.confirmedAt) &&
        state.confirmedAt <= Date.now() + this.options.safetyMarginMs
      ) {
        return state.confirmedAt;
      }
    } catch {
      // Missing or corrupt: unknown.
    }
    return undefined;
  }

  /** Remember that everything written up to `time` is visible. */
  #confirm(time: number): void {
    if (!this.options.stateFile) return;
    if (this.#confirmedAt !== undefined && time <= this.#confirmedAt) return;
    this.#confirmedAt = time;
    this.#scheduleStateWrite();
  }

  /** Write the state at most once per interval. */
  #scheduleStateWrite(): void {
    if (this.#stateTimer !== undefined || this.#closed) return;
    const wait = this.#lastStateWrite + this.options.stateWriteIntervalMs -
      Date.now();
    if (wait <= 0) {
      void this.#flushState();
      return;
    }
    this.#stateTimer = setTimeout(() => {
      this.#stateTimer = undefined;
      void this.#flushState();
    }, wait);
    Deno.unrefTimer(this.#stateTimer as unknown as number);
  }

  /** Write the state file now if it changed (temporary file, then rename). */
  #flushState(): Promise<void> {
    const value = this.#confirmedAt;
    if (!this.options.stateFile || value === undefined) return this.#stateChain;
    if (value === this.#persistedAt) return this.#stateChain;
    this.#lastStateWrite = Date.now();
    this.#stateChain = this.#stateChain.then(async () => {
      const file = this.options.stateFile;
      try {
        await Deno.mkdir(dirname(file), { recursive: true });
        await Deno.writeTextFile(
          `${file}.tmp`,
          JSON.stringify({
            version: STATE_VERSION,
            graphDir: this.config.graphDir,
            baseUri: this.config.baseUri,
            confirmedAt: value,
          }),
        );
        await Deno.rename(`${file}.tmp`, file);
        this.#persistedAt = value;
      } catch (error) {
        this.options.log(`could not write ${file}: ${error}`);
      }
    });
    return this.#stateChain;
  }

  /**
   * Write one of our files and wait until it is visible. `work` calls
   * `written()` right after the file is in place; the file's inode change
   * time is then not later than that instant, which is what `confirmedAt`
   * becomes once the file is confirmed. Until then the file is unconfirmed:
   * if it never shows, `confirmedAt` stays behind it for the rest of the
   * process, so the next start checks the file.
   */
  async #confirmed(
    work: (written: () => void) => Promise<void>,
  ): Promise<void> {
    const started = Date.now();
    let writtenAt = started;
    this.#inFlight.add(started);
    try {
      await work(() => {
        writtenAt = Date.now();
      });
    } catch (error) {
      this.#failed = true;
      throw error;
    } finally {
      this.#inFlight.delete(started);
    }
    if (!this.#failed && this.#inFlight.size === 0) this.#confirm(writtenAt);
  }

  /**
   * Every non-empty `*.nt` file under the graph directory by graph IRI, with
   * the files that must be checked: those that appeared (inode change time)
   * after `confirmedAt` minus the safety margin, or all of them when that
   * time is unknown or a file has no change time.
   */
  async #candidates(
    confirmedAt: number | undefined,
  ): Promise<Map<string, string>> {
    const found = new Map<string, { path: string; ctime: Date | null }>();
    const walk = async (relative: string) => {
      for await (
        const entry of Deno.readDir(join(this.config.graphDir, relative))
      ) {
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory) await walk(path);
        else if (entry.isFile && entry.name.endsWith(".nt")) {
          const info = await Deno.stat(join(this.config.graphDir, path));
          if (info.size > 0) {
            found.set(escapedGraphIri(this.config.baseUri, path), {
              path,
              ctime: info.ctime,
            });
          }
        }
      }
    };
    await walk("");
    const everything = confirmedAt === undefined ||
      [...found.values()].some((f) => f.ctime === null);
    const since = (confirmedAt ?? 0) - this.options.safetyMarginMs;
    const candidates = new Map<string, string>();
    for (const [graph, { path, ctime }] of found) {
      if (everything || ctime!.getTime() > since) candidates.set(graph, path);
    }
    return candidates;
  }

  /** Those of `graphs` that exist and satisfy `condition`, asked in chunks. */
  async #existing(graphs: string[], condition: string): Promise<Set<string>> {
    const found = new Set<string>();
    for (let i = 0; i < graphs.length; i += NAME_CHUNK) {
      const chunk = graphs.slice(i, i + NAME_CHUNK);
      const body = await this.client.evaluate(
        `SELECT ?g WHERE {
          VALUES ?g { ${chunk.map((g) => `<${g}>`).join(" ")} }
          FILTER EXISTS { GRAPH ?g { ${condition} } }
        }`,
        "SELECT",
      );
      const rows: { g: { value: string } }[] = JSON.parse(body).results
        .bindings;
      for (const row of rows) found.add(row.g.value);
    }
    return found;
  }

  async #waitForExistingFiles(): Promise<void> {
    const listingStarted = Date.now();
    const candidates = await this.#candidates(await this.#readState());
    if (candidates.size > 0) await this.#waitFor(candidates);
    // Everything present when the listing started is now known to be visible.
    this.#confirm(listingStarted);
    await this.#flushState();
  }

  async #waitFor(files: Map<string, string>): Promise<void> {
    const { openTimeoutMs, pollStartMs, pollMaxMs, log } = this.options;
    const deadline = Date.now() + openTimeoutMs;
    let pause = pollStartMs;
    let announced = false;
    let lastError = "";
    let missing = [...files.keys()];
    for (;;) {
      try {
        const visible = await this.#existing(missing, "?s ?p ?o");
        missing = missing.filter((g) => !visible.has(g));
        lastError = "";
      } catch (error) {
        lastError = ` (last error: ${
          error instanceof Error ? error.message : error
        })`;
      }
      if (missing.length === 0 && lastError === "") break;
      if (Date.now() >= deadline) {
        const sample = missing.slice(0, 5).map((g) => files.get(g));
        throw new Error(
          `qlever-dir at ${this.config.queryUrl} did not show ${missing.length} of ${files.size} files of ${this.config.graphDir} within ${
            Math.round(openTimeoutMs / 1000)
          } s, for example ${sample.join(", ")}. Their graphs must be named ` +
            `under QLEVER_DIR_BASE_URI (${this.config.baseUri}), which has to equal ` +
            `qlever-dir's BASE_URI plus this directory's path inside its /data${lastError}`,
        );
      }
      if (!announced && lastError === "") {
        announced = true;
        log(
          `waiting for qlever-dir to apply ${missing.length} of ${files.size} files that may not be indexed yet in ${this.config.graphDir}`,
        );
      }
      await sleep(pause);
      pause = Math.min(pause * 2, pollMaxMs);
    }
    log(`all ${files.size} checked files are visible in qlever-dir`);
    // Only these can be newly rejected; older rejected files are not repeated.
    try {
      const rejected = await this.#existing(
        [...files.keys()],
        `?s <${PARSING_ERROR}> ?o`,
      );
      for (const [graph, path] of files) {
        if (rejected.has(graph)) {
          log(
            `WARNING: qlever-dir could not parse ${path}; only an error triple is indexed for it`,
          );
        }
      }
    } catch (error) {
      log(`could not check for parse errors: ${error}`);
    }
  }

  /** Start the periodic and the initial consolidation. */
  startConsolidation(store: QleverDirStore): void {
    const run = () =>
      store.consolidate().catch((error) =>
        this.options.log(`consolidation failed: ${error}`)
      );
    if (this.options.consolidateEveryMs > 0) {
      const timer = setInterval(run, this.options.consolidateEveryMs);
      Deno.unrefTimer(timer as unknown as number);
      this.#timer = timer;
    }
    if (this.options.consolidateOnOpen) void run();
  }

  /** The relative path of the next batch file, unique within the directory. */
  async #newFile(): Promise<string> {
    const now = this.options.now();
    for (;;) {
      const name = `${now.getTime()}-${
        String(this.#sequence++).padStart(6, "0")
      }.nt`;
      const relative = `${dayPath(now)}/${name}`;
      try {
        await Deno.stat(join(this.config.graphDir, relative));
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return relative;
        throw error;
      }
    }
  }

  /**
   * Write `content` to `<graphDir>/<relative>` atomically: a temporary file
   * qlever-dir ignores, renamed into place.
   */
  async #write(relative: string, content: string): Promise<void> {
    const path = join(this.config.graphDir, relative);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(`${path}.tmp`, content);
    await Deno.rename(`${path}.tmp`, path);
  }

  /**
   * Poll until the graph of `relative` is visible (and holds at least
   * `minTriples` triples). Query errors are retried until the timeout.
   */
  async #waitVisible(relative: string, minTriples = 1): Promise<void> {
    const graph = graphIri(this.config.baseUri, relative);
    const { visibleTimeoutMs, pollStartMs, pollMaxMs } = this.options;
    const deadline = Date.now() + visibleTimeoutMs;
    let pause = pollStartMs;
    let lastError = "the graph was not there yet";
    while (!this.#closed) {
      try {
        const body = await this.client.evaluate(
          `SELECT (COUNT(*) AS ?n) (COUNT(?e) AS ?errors) WHERE {
            GRAPH <${graph}> { ?s ?p ?o OPTIONAL { ?s <${PARSING_ERROR}> ?e } }
          }`,
          "SELECT",
        );
        const row = JSON.parse(body).results.bindings[0];
        if (Number(row.errors.value) > 0) {
          throw new Error(
            `qlever-dir could not parse ${relative}; it holds only an error triple`,
          );
        }
        if (Number(row.n.value) >= minTriples) return;
        lastError = `the graph holds ${row.n.value} of ${minTriples} triples`;
      } catch (error) {
        if (
          error instanceof Error && error.message.includes("could not parse")
        ) {
          throw error;
        }
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `qlever-dir endpoint ${this.config.queryUrl} did not show ${relative} ` +
            `(graph <${graph}>) within ${
              Math.round(visibleTimeoutMs / 1000)
            } s (${lastError}). Most likely QLEVER_DIR_BASE_URI (currently ` +
            `${this.config.baseUri}) does not equal qlever-dir's BASE_URI plus the ` +
            `path of ${this.config.graphDir} inside its /data; otherwise qlever-dir ` +
            `may be down or far behind. The file is kept in ${this.config.graphDir} ` +
            `and will be indexed when qlever-dir catches up.`,
        );
      }
      await sleep(pause);
      pause = Math.min(pause * 2, pollMaxMs);
    }
    throw new Error("Store is closed");
  }

  async insert(ntriples: string, options?: InsertOptions): Promise<void> {
    if (this.#closed) throw new Error("Store is closed");
    const content = ntriples.endsWith("\n") ? ntriples : ntriples + "\n";
    assertPlausibleNTriples(content);
    const relative = await this.#newFile();
    await this.#confirmed(async (written) => {
      await this.#write(relative, content);
      written();
      // The file is in place: qlever-dir indexes it eventually, even if that
      // takes longer than the wait below (a rebuild of the index).
      try {
        options?.onDurable?.();
      } catch (error) {
        this.options.log(`onDurable failed: ${error}`);
      }
      await this.#waitVisible(relative);
    });
  }

  evaluate(
    sparql: string,
    form: Parameters<Backend["evaluate"]>[1],
    options?: QueryOptions,
  ): Promise<string> {
    return this.#queries.evaluate(sparql, form, {
      untrustedTimeoutMs: options?.untrusted
        ? this.options.untrustedTimeoutMs
        : undefined,
    });
  }

  size(): Promise<number> {
    return this.#queries.size();
  }

  consolidate(now: Date = this.options.now()): Promise<void> {
    const run = this.#consolidation.then(() => this.#consolidate(now));
    this.#consolidation = run.catch(() => {});
    return run;
  }

  async #consolidate(now: Date): Promise<void> {
    const startOfToday = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    const cutoff = startOfToday - DAY_MS;
    for (const year of await this.#subdirs(this.config.graphDir, /^\d{4}$/)) {
      const yearDir = join(this.config.graphDir, year);
      for (const month of await this.#subdirs(yearDir, /^\d{2}$/)) {
        const monthDir = join(yearDir, month);
        for (const day of await this.#subdirs(monthDir, /^\d{2}$/)) {
          if (this.#closed) return;
          const start = Date.UTC(Number(year), Number(month) - 1, Number(day));
          if (start < cutoff) {
            await this.#mergeDay(`${year}/${month}`, day);
          }
        }
      }
    }
  }

  async #subdirs(dir: string, pattern: RegExp): Promise<string[]> {
    const names: string[] = [];
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isDirectory && pattern.test(entry.name)) {
          names.push(entry.name);
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    return names.sort();
  }

  async #batchFiles(dir: string): Promise<string[]> {
    const names: string[] = [];
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && BATCH_NAME.test(entry.name)) names.push(entry.name);
      else {
        // Not ours (or a write in progress): leave the whole day alone.
        throw new ForeignContent(entry.name);
      }
    }
    return names.sort();
  }

  /**
   * Merge one day. Crash-safe by construction: until the directory is gone,
   * the merged file and the batch files hold the same triples, and a rerun
   * folds whatever is left into the merged file again.
   */
  async #mergeDay(month: string, day: string): Promise<void> {
    const dayDir = join(this.config.graphDir, month, day);
    const mergedRelative = `${month}/${day}.nt`;
    const mergedPath = join(this.config.graphDir, mergedRelative);
    let files: string[];
    try {
      files = await this.#batchFiles(dayDir);
    } catch (error) {
      if (!(error instanceof ForeignContent)) throw error;
      this.options.log(`not consolidating ${dayDir}: ${error.message}`);
      return;
    }
    let existing: string | undefined;
    try {
      existing = await Deno.readTextFile(mergedPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    if (files.length < 2 && !(files.length === 1 && existing !== undefined)) {
      return;
    }

    // Lines are unique so that repeating an interrupted merge changes nothing.
    const lines = new Set<string>();
    const add = (text: string) => {
      for (const line of text.split("\n")) if (line !== "") lines.add(line);
    };
    if (existing !== undefined) add(existing);
    const known = lines.size;
    for (const file of files) add(await Deno.readTextFile(join(dayDir, file)));
    const merged = [...lines].join("\n") + "\n";

    await this.#confirmed(async (written) => {
      if (existing === undefined || lines.size !== known) {
        await this.#write(mergedRelative, merged);
        written();
      }
      await this.#waitVisible(mergedRelative, lines.size);
    });

    // Nothing may have arrived meanwhile that the merged file does not hold.
    const after = await this.#batchFiles(dayDir).catch((error) => {
      if (error instanceof ForeignContent) return undefined;
      throw error;
    });
    if (after?.join("\n") !== files.join("\n")) return;
    await Deno.remove(dayDir, { recursive: true });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    if (this.#stateTimer !== undefined) clearTimeout(this.#stateTimer);
    await this.#consolidation;
    await this.#flushState();
  }
}

/**
 * Open the store: create `config.graphDir`, wait for the endpoint, and wait
 * until the files that may not be indexed yet are visible (files that appeared
 * after the `confirmedAt` time kept in `options.stateFile`, or every file when
 * that is unknown).
 *
 * `insert` writes the batch as `<graphDir>/YYYY/MM/DD/<unix ms>-<sequence>.nt`
 * (UTC day of writing) and resolves once the endpoint shows the file's graph.
 * If that does not happen within the timeout, `insert` rejects with an error
 * naming the file; the file stays on disk, is durable, and qlever-dir will
 * index it eventually. A batch with a line that is not a plausible triple is
 * rejected before anything is written.
 */
export async function openQleverDirStore(
  config: QleverConfig,
  options: QleverDirOptions = {},
): Promise<QleverDirStore> {
  const backend = new QleverDirBackend(config, options);
  await backend.open();
  const store: QleverDirStore = Object.assign(tripleStore(backend), {
    consolidate: (now?: Date) => backend.consolidate(now),
  });
  backend.startConsolidation(store);
  return store;
}
