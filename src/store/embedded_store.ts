/**
 * The embedded {@link TripleStore}: Oxigraph in a worker, persisted as an
 * append-only N-Triples log. See `embedded_worker.ts` for the worker side.
 *
 * Queries that come from outside (`/sparql`) never run in that worker: a
 * WebAssembly query cannot be interrupted, and while it runs the worker serves
 * no insert and no internal query. They run in a second worker, the replica,
 * which holds a copy of the graph and can be terminated when a query runs out
 * of time. See {@link EmbeddedBackend}.
 *
 * @module
 */
import {
  QueryLimitError,
  type QueryOptions,
  type TripleStore,
} from "../types.ts";
import { type Backend, tripleStore } from "./backend.ts";
import type { WorkerOperation, WorkerResponse } from "./embedded_worker.ts";
import { resultType } from "./sparql_form.ts";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

/** One worker running `embedded_worker.ts`, spoken to with request ids. */
class WorkerClient {
  readonly #worker: Worker;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed = false;
  /** The worker failed or was terminated: no call will ever be answered. */
  dead = false;

  constructor() {
    this.#worker = new Worker(
      new URL("./embedded_worker.ts", import.meta.url).href,
      { type: "module" },
    );
    this.#worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      this.#pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error(response.error));
    };
    this.#worker.onerror = (event) => {
      event.preventDefault();
      this.dead = true;
      this.#failAll(new Error(`Store worker failed: ${event.message}`));
    };
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  call(request: WorkerOperation): Promise<unknown> {
    if (this.#closed || this.dead) {
      return Promise.reject(new Error("Store is closed"));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ ...request, id });
    });
  }

  /** Stop the worker at once, even in the middle of a query. */
  terminate(error: Error): void {
    this.#closed = true;
    this.dead = true;
    this.#worker.terminate();
    this.#failAll(error);
  }
}

/** Options of the embedded store. */
export interface EmbeddedOptions {
  /**
   * Time limit of a query that came from outside (default 10 s). The clock
   * starts when the query starts to run, not when it was accepted.
   */
  untrustedTimeoutMs?: number;
  /**
   * How many untrusted queries may wait for the replica while another one
   * runs (default 32, enough for the queries of one page of the web client); further ones fail at once. A query that has waited for
   * longer than the time limit fails too.
   */
  maxQueuedQueries?: number;
}

/** An untrusted query on its way to the replica. */
interface Job {
  sparql: string;
  form: Parameters<Backend["evaluate"]>[1];
  resolve: (body: string) => void;
  reject: (error: Error) => void;
  /** Fails the job when it has waited too long; cleared when it starts. */
  waitTimer?: ReturnType<typeof setTimeout>;
}

/** A replica being filled. */
interface Build {
  client: WorkerClient;
  /** Batches inserted since the build started, in order. */
  backlog: string[];
  /** Started because a replica was terminated, not because it is the first. */
  rebuild: boolean;
}

/**
 * The primary worker plus, once an untrusted query has asked for it, the
 * replica.
 *
 * The replica is a second worker with its own Oxigraph store. It is built
 * from `graph.nt` and then fed every batch the primary accepts, in the order
 * the primary accepted them, before `insert` returns to its caller. It never
 * writes the log.
 *
 * A build cannot miss a batch: the log already holds every batch whose
 * `insert` has returned. A batch still in flight when the build begins returns
 * later, and every batch that returns while the build runs is kept in
 * `backlog` and loaded as soon as the log is read, in the same step that
 * makes the replica available. A batch can reach the replica twice, once from
 * the log and once from the backlog; the graph is a set, so that is harmless.
 *
 * When an untrusted query exceeds the time limit the replica is terminated
 * and rebuilt in the background. Untrusted queries arriving meanwhile fail
 * with a `busy` {@link QueryLimitError}. The very first build, started by the
 * first untrusted query, is waited for instead.
 */
class EmbeddedBackend implements Backend {
  readonly #primary = new WorkerClient();
  readonly #dataDir: string;
  readonly #timeoutMs: number;
  readonly #maxQueued: number;
  #closed = false;

  #replica?: WorkerClient;
  #build?: Build;
  #lastBuildMs = 0;
  readonly #queue: Job[] = [];
  #running = false;

  constructor(dataDir: string, options: EmbeddedOptions) {
    this.#dataDir = dataDir;
    this.#timeoutMs = options.untrustedTimeoutMs ?? 10_000;
    this.#maxQueued = options.maxQueuedQueries ?? 32;
  }

  async open(): Promise<void> {
    await this.#primary.call({ op: "open", dataDir: this.#dataDir });
  }

  async insert(ntriples: string): Promise<void> {
    await this.#primary.call({ op: "insert", ntriples });
    // After the primary has accepted the batch and before the caller hears
    // about it, so that a query issued afterwards is ordered behind the load.
    const replica = this.#replica;
    if (replica) {
      replica.call({ op: "load", ntriples }).catch(() => this.#lose(replica));
    } else this.#build?.backlog.push(ntriples);
  }

  evaluate(
    sparql: string,
    form: Parameters<Backend["evaluate"]>[1],
    options?: QueryOptions,
  ): Promise<string> {
    if (!options?.untrusted) {
      return this.#primary.call({
        op: "query",
        sparql,
        format: resultType(form),
      }) as Promise<string>;
    }
    return this.#untrusted(sparql, form);
  }

  #untrusted(
    sparql: string,
    form: Parameters<Backend["evaluate"]>[1],
  ): Promise<string> {
    if (this.#closed) return Promise.reject(new Error("Store is closed"));
    if (this.#build?.rebuild) {
      return Promise.reject(this.#busy("the query service is restarting"));
    }
    if (this.#queue.length >= this.#maxQueued) {
      return Promise.reject(this.#busy("too many queries are waiting"));
    }
    return new Promise((resolve, reject) => {
      const job: Job = { sparql, form, resolve, reject };
      job.waitTimer = setTimeout(() => {
        this.#queue.splice(this.#queue.indexOf(job), 1);
        reject(
          this.#busy(
            this.#build
              ? "the query service is still starting"
              : "the query waited too long for its turn",
          ),
        );
      }, this.#timeoutMs);
      this.#queue.push(job);
      if (!this.#replica && !this.#build) this.#startBuild(false);
      this.#pump();
    });
  }

  #busy(why: string): QueryLimitError {
    const seconds = this.#build?.rebuild
      ? Math.min(60, Math.max(2, Math.ceil(this.#lastBuildMs / 1000)))
      : 1;
    return new QueryLimitError(
      "busy",
      `${why}; try again in a few seconds`,
      seconds,
    );
  }

  /** Start the next waiting query when the replica is free. */
  #pump(): void {
    const replica = this.#replica;
    if (!replica || this.#running) return;
    const job = this.#queue.shift();
    if (!job) return;
    clearTimeout(job.waitTimer);
    this.#running = true;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      this.#running = false;
      job.reject(
        new QueryLimitError(
          "timeout",
          `the query took longer than ${this.#timeoutMs / 1000} seconds`,
        ),
      );
      this.#lose(replica);
    }, this.#timeoutMs);
    replica.call({
      op: "query",
      sparql: job.sparql,
      format: resultType(job.form),
    })
      .then(
        (body) => {
          if (settled) return;
          job.resolve(body as string);
        },
        (error) => {
          if (settled) return;
          job.reject(
            replica.dead
              ? this.#busy("the query service is restarting")
              : error instanceof Error
              ? error
              : new Error(String(error)),
          );
        },
      )
      .finally(() => {
        clearTimeout(timer);
        if (settled || this.#replica !== replica) return;
        settled = true;
        this.#running = false;
        this.#pump();
      });
  }

  /**
   * Throw the replica away and build a new one in the background. Queries
   * waiting for it fail as `busy`.
   */
  #lose(replica: WorkerClient): void {
    if (this.#replica !== replica || this.#closed) return;
    this.#replica = undefined;
    replica.terminate(new Error("The query replica was stopped"));
    this.#running = false;
    this.#startBuild(true);
    for (const job of this.#queue.splice(0)) {
      clearTimeout(job.waitTimer);
      job.reject(this.#busy("the query service is restarting"));
    }
  }

  #startBuild(rebuild: boolean): void {
    const started = Date.now();
    const build: Build = { client: new WorkerClient(), backlog: [], rebuild };
    this.#build = build;
    build.client.call({ op: "load-log", dataDir: this.#dataDir }).then(() => {
      if (this.#build !== build) return;
      // No await from here to the end: the backlog is complete when the
      // replica becomes visible to `insert`.
      for (const ntriples of build.backlog) {
        build.client.call({ op: "load", ntriples }).catch(() =>
          this.#lose(build.client)
        );
      }
      this.#lastBuildMs = Date.now() - started;
      this.#build = undefined;
      this.#replica = build.client;
      this.#pump();
    }).catch((error) => {
      if (this.#build !== build) return;
      this.#build = undefined;
      build.client.terminate(new Error("The query replica failed"));
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const job of this.#queue.splice(0)) {
        clearTimeout(job.waitTimer);
        job.reject(failure);
      }
    });
  }

  async size(): Promise<number> {
    return await this.#primary.call({ op: "size" }) as number;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const error = new Error("Store is closed");
    for (const job of this.#queue.splice(0)) {
      clearTimeout(job.waitTimer);
      job.reject(error);
    }
    this.#replica?.terminate(error);
    this.#replica = undefined;
    this.#build?.client.terminate(error);
    this.#build = undefined;
    try {
      // A worker that already failed has nothing to close.
      if (!this.#primary.dead) await this.#primary.call({ op: "close" });
    } finally {
      this.#primary.terminate(error);
    }
  }
}

/**
 * Open the embedded store in `dataDir` (created if missing), replaying
 * `graph.nt`. `insert` resolves once the batch is loaded and appended to the
 * log; a batch Oxigraph rejects is neither loaded nor appended.
 */
export async function openEmbeddedStore(
  dataDir: string,
  options: EmbeddedOptions = {},
): Promise<TripleStore> {
  const backend = new EmbeddedBackend(dataDir, options);
  try {
    await backend.open();
  } catch (error) {
    await backend.close();
    throw error;
  }
  return tripleStore(backend);
}
