/**
 * The embedded {@link TripleStore}: Oxigraph in a worker, persisted as an
 * append-only N-Triples log. See `embedded_worker.ts` for the worker side.
 *
 * @module
 */
import type { TripleStore } from "../types.ts";
import { type Backend, tripleStore } from "./backend.ts";
import type { WorkerOperation, WorkerResponse } from "./embedded_worker.ts";
import { resultType } from "./sparql_form.ts";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

class WorkerBackend implements Backend {
  readonly #worker: Worker;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed = false;

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
      this.#failAll(new Error(`Store worker failed: ${event.message}`));
    };
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  call(request: WorkerOperation): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("Store is closed"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ ...request, id });
    });
  }

  async insert(ntriples: string): Promise<void> {
    await this.call({ op: "insert", ntriples });
  }

  async evaluate(
    sparql: string,
    form: Parameters<Backend["evaluate"]>[1],
  ): Promise<string> {
    return await this.call({
      op: "query",
      sparql,
      format: resultType(form),
    }) as string;
  }

  async size(): Promise<number> {
    return await this.call({ op: "size" }) as number;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.call({ op: "close" });
    } finally {
      this.#closed = true;
      this.#worker.terminate();
      this.#failAll(new Error("Store is closed"));
    }
  }
}

/**
 * Open the embedded store in `dataDir` (created if missing), replaying
 * `graph.nt`. `insert` resolves once the batch is loaded and appended to the
 * log; a batch Oxigraph rejects is neither loaded nor appended.
 */
export async function openEmbeddedStore(dataDir: string): Promise<TripleStore> {
  const backend = new WorkerBackend();
  try {
    await backend.call({ op: "open", dataDir });
  } catch (error) {
    await backend.close();
    throw error;
  }
  return tripleStore(backend);
}
