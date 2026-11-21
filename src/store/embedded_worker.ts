/**
 * The worker that hosts the embedded Oxigraph store, so that slow queries
 * never block the main event loop. It owns the append-only log
 * `<dataDir>/graph.nt`. A second instance of this worker serves as the
 * read-only replica for untrusted queries: it only ever gets `load-log`,
 * `load`, `query` and `close`, and never writes the log. The protocol is request/response with ids; see
 * {@link WorkerRequest} and {@link WorkerResponse}.
 *
 * @module
 */
import oxigraph from "oxigraph";

/** What the main thread asks the worker to do. */
export type WorkerOperation =
  | { op: "open"; dataDir: string }
  | { op: "insert"; ntriples: string }
  /** Replica only: read `<dataDir>/graph.nt` without touching it. */
  | { op: "load-log"; dataDir: string }
  /** Replica only: add triples without writing the log. */
  | { op: "load"; ntriples: string }
  | { op: "query"; sparql: string; format: string }
  | { op: "size" }
  | { op: "close" }
  /** Tests only: fail with an uncaught error, as a crashing worker does. */
  | { op: "crash" };

/** A {@link WorkerOperation} tagged with the id its response will carry. */
export type WorkerRequest = WorkerOperation & { id: number };

/** The worker's answer to the request with the same id. */
export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

const NT = "application/n-triples";
const CHUNK_BYTES = 32 * 1024 * 1024;
const NEWLINE = 0x0a;

const store = new oxigraph.Store();
let log: Deno.FsFile | undefined;

/**
 * Load the log in chunks of complete lines. A log that does not end in a
 * newline was cut in the middle of a write: the partial line is dropped and
 * the file truncated so that later appends start on a fresh line.
 */
async function replay(path: string, repair = true): Promise<void> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const buffer = new Uint8Array(CHUNK_BYTES);
  let pending = new Uint8Array(0);
  let complete = 0;
  try {
    for (;;) {
      const n = await file.read(buffer);
      if (n === null) break;
      const bytes = new Uint8Array(pending.length + n);
      bytes.set(pending);
      bytes.set(buffer.subarray(0, n), pending.length);
      const end = bytes.lastIndexOf(NEWLINE) + 1;
      if (end > 0) {
        try {
          store.load(decoder.decode(bytes.subarray(0, end)), { format: NT });
        } catch (error) {
          throw new Error(
            `Corrupt triple log ${path} near byte ${complete}: ${error}`,
          );
        }
        complete += end;
      }
      pending = bytes.slice(end);
    }
  } finally {
    file.close();
  }
  // A replica reads a log the primary may be appending to: the partial line is
  // then just a write in progress, and the batch it belongs to reaches the
  // replica through `load`.
  if (repair && pending.length > 0) await Deno.truncate(path, complete);
}

async function append(bytes: Uint8Array): Promise<void> {
  if (!log) throw new Error("Store is not open");
  for (let written = 0; written < bytes.length;) {
    written += await log.write(bytes.subarray(written));
  }
}

async function handle(request: WorkerRequest): Promise<unknown> {
  switch (request.op) {
    case "open": {
      await Deno.mkdir(request.dataDir, { recursive: true });
      const path = `${request.dataDir}/graph.nt`;
      await replay(path);
      log = await Deno.open(path, { append: true, create: true });
      return store.size;
    }
    case "insert":
      // Oxigraph loads a batch atomically, so a rejected batch leaves neither
      // the graph nor the log changed.
      store.load(request.ntriples, { format: NT });
      await append(new TextEncoder().encode(request.ntriples));
      return undefined;
    case "load-log":
      await replay(`${request.dataDir}/graph.nt`, false);
      return store.size;
    case "load":
      store.load(request.ntriples, { format: NT });
      return undefined;
    case "query":
      return store.query(request.sparql, { results_format: request.format });
    case "size":
      return store.size;
    case "crash":
      setTimeout(() => {
        throw new Error("crash requested by a test");
      }, 0);
      return undefined;
    case "close":
      log?.close();
      log = undefined;
      return undefined;
  }
}

const scope = self as unknown as {
  onmessage: (event: MessageEvent<WorkerRequest>) => void;
  postMessage(message: WorkerResponse): void;
};

scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { id } = event.data;
  let response: WorkerResponse;
  try {
    response = { id, ok: true, result: await handle(event.data) };
  } catch (error) {
    response = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  scope.postMessage(response);
};
