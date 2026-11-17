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
import { FairQueue } from "./fair_queue.ts";
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
  /** Called once when the worker failed by itself (not when terminated). */
  onDeath?: () => void;

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
      if (this.#closed) return;
      this.dead = true;
      this.#failAll(new Error(`Store worker failed: ${event.message}`));
      this.onDeath?.();
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

  /** For tests: make the worker fail with an uncaught error. */
  crash(): void {
    this.#worker.postMessage({ op: "crash", id: 0 });
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
   * How many untrusted queries may wait for a replica while the others run
   * (default 32, enough for the queries of one page of the web client);
   * further ones fail at once. A query that has waited for longer than the
   * time limit fails too.
   */
  maxQueuedQueries?: number;
  /**
   * Number of replica workers, 1 to 4 (default 1). Each holds its own copy of
   * the graph, so memory grows by one graph per worker. With N workers, N
   * untrusted queries run at once.
   */
  workers?: number;
  /**
   * Shortest wait before a replica whose rebuild failed is tried again
   * (default 1 s; it doubles with every failure up to 30 s). A replica that
   * is not built is only retried when a query asks for it.
   */
  rebuildBackoffMs?: number;
  /** For tests: called with every replica worker that is started. */
  onReplicaStart?: (replica: { crash(): void }) => void;
}

/** An untrusted query on its way to a replica. */
interface Job {
  sparql: string;
  form: Parameters<Backend["evaluate"]>[1];
  onStart?: () => void;
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
  /** Started because a replica was lost, not because it is the first. */
  rebuild: boolean;
}

/** One place for a replica worker: empty, being built, or answering. */
interface Slot {
  /** The worker that answers queries; set once it has been built. */
  client?: WorkerClient;
  /** A query runs on `client`. */
  busy: boolean;
  build?: Build;
  /** Builds that failed in a row. */
  failures: number;
  /** An empty slot is not rebuilt before this time (ms since epoch). */
  retryAt: number;
}

const MAX_BACKOFF_MS = 30_000;

/**
 * The primary worker plus, once an untrusted query has asked for them, the
 * replicas.
 *
 * A replica is a further worker with its own Oxigraph store. It is built from
 * `graph.nt` and then fed every batch the primary accepts, in the order the
 * primary accepted them, before `insert` returns to its caller. It never
 * writes the log. Each replica (`workers` of them, default one) runs one query
 * at a time; waiting queries are served client by client in turn (see
 * {@link FairQueue}).
 *
 * A build cannot miss a batch: the log already holds every batch whose
 * `insert` has returned. A batch still in flight when the build begins returns
 * later, and every batch that returns while the build runs is kept in the
 * slot's `backlog` and loaded as soon as the log is read, in the same step that
 * makes the replica available. A batch can reach the replica twice, once from
 * the log and once from the backlog; the graph is a set, so that is harmless.
 *
 * A replica that exceeds the time limit, or whose worker fails for any other
 * reason, is terminated and rebuilt in the background; the other replicas keep
 * answering. While no replica is usable, untrusted queries fail with a `busy`
 * {@link QueryLimitError}. The very first build, started by the first
 * untrusted query, is waited for instead. A rebuild that fails leaves the slot
 * empty; it is tried again by a later query, after a pause that grows with the
 * failures, so a broken build cannot loop.
 */
class EmbeddedBackend implements Backend {
  readonly #primary = new WorkerClient();
  readonly #dataDir: string;
  readonly #timeoutMs: number;
  readonly #maxQueued: number;
  readonly #backoffMs: number;
  readonly #onReplicaStart?: EmbeddedOptions["onReplicaStart"];
  #closed = false;

  readonly #slots: Slot[];
  #lastBuildMs = 0;
  readonly #queue = new FairQueue<Job>();

  constructor(dataDir: string, options: EmbeddedOptions) {
    this.#dataDir = dataDir;
    this.#timeoutMs = options.untrustedTimeoutMs ?? 10_000;
    this.#maxQueued = options.maxQueuedQueries ?? 32;
    this.#backoffMs = options.rebuildBackoffMs ?? 1000;
    this.#onReplicaStart = options.onReplicaStart;
    const workers = options.workers ?? 1;
    if (!Number.isInteger(workers) || workers < 1 || workers > 4) {
      throw new RangeError("workers must be 1 to 4");
    }
    this.#slots = Array.from({ length: workers }, () => ({
      busy: false,
      failures: 0,
      retryAt: 0,
    }));
  }

  async open(): Promise<void> {
    await this.#primary.call({ op: "open", dataDir: this.#dataDir });
  }

  async insert(ntriples: string): Promise<void> {
    await this.#primary.call({ op: "insert", ntriples });
    // After the primary has accepted the batch and before the caller hears
    // about it, so that a query issued afterwards is ordered behind the load.
    for (const slot of this.#slots) {
      const replica = slot.client;
      if (replica) {
        replica.call({ op: "load", ntriples }).catch(() =>
          this.#lose(slot, replica)
        );
      } else slot.build?.backlog.push(ntriples);
    }
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
    return this.#untrusted(sparql, form, options);
  }

  /** A slot that is, or soon will be, able to answer. */
  #usable(slot: Slot): boolean {
    return slot.client !== undefined || (slot.build?.rebuild === false);
  }

  #untrusted(
    sparql: string,
    form: Parameters<Backend["evaluate"]>[1],
    options: QueryOptions,
  ): Promise<string> {
    if (this.#closed) return Promise.reject(new Error("Store is closed"));
    this.#ensureReplicas();
    if (!this.#slots.some((slot) => this.#usable(slot))) {
      return Promise.reject(this.#busy("the query service is restarting"));
    }
    if (this.#queue.length >= this.#maxQueued) {
      return Promise.reject(this.#busy("too many queries are waiting"));
    }
    return new Promise((resolve, reject) => {
      const job: Job = {
        sparql,
        form,
        onStart: options.onStart,
        resolve,
        reject,
      };
      job.waitTimer = setTimeout(() => {
        this.#queue.remove(job);
        reject(
          this.#busy(
            this.#slots.some((slot) => slot.build)
              ? "the query service is still starting"
              : "the query waited too long for its turn",
          ),
        );
      }, this.#timeoutMs);
      this.#queue.push(options.client ?? "", job);
      this.#pump();
    });
  }

  /** Start a build in every empty slot that is not waiting out a failure. */
  #ensureReplicas(): void {
    const now = Date.now();
    for (const slot of this.#slots) {
      if (!slot.client && !slot.build && now >= slot.retryAt) {
        this.#startBuild(slot, slot.failures > 0);
      }
    }
  }

  #busy(why: string): QueryLimitError {
    const now = Date.now();
    let seconds = 1;
    if (this.#slots.some((slot) => slot.build?.rebuild)) {
      seconds = Math.min(60, Math.max(2, Math.ceil(this.#lastBuildMs / 1000)));
    } else if (this.#slots.every((slot) => !slot.client && !slot.build)) {
      const next = Math.min(...this.#slots.map((slot) => slot.retryAt));
      seconds = Math.max(1, Math.ceil((next - now) / 1000));
    }
    return new QueryLimitError(
      "busy",
      `${why}; try again in a few seconds`,
      seconds,
    );
  }

  /** The next waiting query whose client may start it. */
  #nextJob(): Job | undefined {
    for (let job = this.#queue.shift(); job; job = this.#queue.shift()) {
      clearTimeout(job.waitTimer);
      try {
        job.onStart?.();
      } catch (error) {
        job.reject(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      return job;
    }
    return undefined;
  }

  /** Give waiting queries to the replicas that are free. */
  #pump(): void {
    for (const slot of this.#slots) {
      if (!slot.client || slot.busy) continue;
      const job = this.#nextJob();
      if (!job) return;
      this.#run(slot, slot.client, job);
    }
  }

  #run(slot: Slot, replica: WorkerClient, job: Job): void {
    slot.busy = true;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      job.reject(
        new QueryLimitError(
          "timeout",
          `the query took longer than ${this.#timeoutMs / 1000} seconds`,
        ),
      );
      this.#lose(slot, replica);
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
        if (settled || slot.client !== replica) return;
        settled = true;
        slot.busy = false;
        this.#pump();
      });
  }

  /**
   * Throw a replica away (it ran out of time, failed or could not load a
   * batch) and build a new one in the background. When no other replica can
   * answer, the queries waiting fail as `busy`.
   */
  #lose(slot: Slot, replica: WorkerClient): void {
    if (slot.client !== replica || this.#closed) return;
    slot.client = undefined;
    slot.busy = false;
    replica.terminate(new Error("The query replica was stopped"));
    this.#startBuild(slot, true);
    this.#failQueueIfUnserved();
  }

  #failQueueIfUnserved(): void {
    if (this.#slots.some((slot) => this.#usable(slot))) return;
    for (const job of this.#queue.drain()) {
      clearTimeout(job.waitTimer);
      job.reject(this.#busy("the query service is restarting"));
    }
  }

  #startBuild(slot: Slot, rebuild: boolean): void {
    const started = Date.now();
    const client = new WorkerClient();
    const build: Build = { client, backlog: [], rebuild };
    slot.build = build;
    client.onDeath = () => this.#lose(slot, client);
    this.#onReplicaStart?.({ crash: () => client.crash() });
    client.call({ op: "load-log", dataDir: this.#dataDir }).then(() => {
      if (slot.build !== build) return;
      // No await from here to the end: the backlog is complete when the
      // replica becomes visible to `insert`.
      for (const ntriples of build.backlog) {
        client.call({ op: "load", ntriples }).catch(() =>
          this.#lose(slot, client)
        );
      }
      this.#lastBuildMs = Date.now() - started;
      slot.build = undefined;
      slot.client = client;
      slot.failures = 0;
      this.#pump();
    }).catch((error) => {
      if (slot.build !== build) return;
      slot.build = undefined;
      client.terminate(new Error("The query replica failed"));
      slot.failures++;
      slot.retryAt = Date.now() +
        Math.min(MAX_BACKOFF_MS, this.#backoffMs * 2 ** (slot.failures - 1));
      if (this.#slots.some((other) => this.#usable(other))) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const job of this.#queue.drain()) {
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
    for (const job of this.#queue.drain()) {
      clearTimeout(job.waitTimer);
      job.reject(error);
    }
    for (const slot of this.#slots) {
      slot.client?.terminate(error);
      slot.client = undefined;
      slot.build?.client.terminate(error);
      slot.build = undefined;
    }
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
