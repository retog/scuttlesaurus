/**
 * The seed's connections to a node: its node API, its Blossom server and its
 * relay. These are the only parts of the node the seed uses; it never imports
 * the node's code.
 * @module
 */
import { finalizeEvent } from "@nostr/tools/pure";
import { encodeBase64 } from "@std/encoding/base64";
import type { PersonaKey } from "./keys.ts";
import type { SignedEvent } from "./model.ts";

/** The node could not be reached, or did not answer the status request. */
export class NodeUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeUnreachableError";
  }
}

/** The part of `GET /api/status` the seed reads. */
export interface NodeStatus {
  readonly owner: string | null;
  readonly setupRequired: boolean;
  readonly hops: number;
}

/** The body of `GET /api/graph`. */
export interface GraphDocument {
  readonly owner: string | null;
  readonly hops: number;
  readonly distances: Readonly<Record<string, number>>;
}

/** The answer of the relay to one event. */
export interface PublishOutcome {
  readonly ok: boolean;
  readonly message: string;
}

const HTTP_TIMEOUT_MS = 10_000;
const PUBLISH_TIMEOUT_MS = 15_000;
const AUTH_LIFETIME_SECONDS = 300;

/** Client of a node's HTTP interfaces: the node API and Blossom. */
export class NodeClient {
  readonly #base: URL;

  /** `base` is the node's URL, e.g. `http://127.0.0.1:7777`. */
  constructor(base: string) {
    this.#base = new URL(base);
  }

  /** The node's public URL. */
  get url(): string {
    return this.#base.origin;
  }

  /** The URL of the relay, the same host with the `ws:` scheme. */
  relayUrl(): string {
    const url = new URL("/", this.#base);
    url.protocol = this.#base.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  /** `GET /api/status`. */
  async status(): Promise<NodeStatus> {
    const doc = await this.#json("/api/status");
    return {
      owner: typeof doc.owner === "string" ? doc.owner : null,
      setupRequired: doc.setupRequired === true,
      hops: typeof doc.hops === "number" ? doc.hops : 2,
    };
  }

  /** `POST /api/setup` with the owner's hex public key. */
  async setup(owner: string): Promise<void> {
    await this.#json("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner }),
    });
  }

  /** `GET /api/graph`. */
  async graph(): Promise<GraphDocument> {
    const doc = await this.#json("/api/graph");
    const distances =
      typeof doc.distances === "object" && doc.distances !== null
        ? doc.distances as Record<string, number>
        : {};
    return {
      owner: typeof doc.owner === "string" ? doc.owner : null,
      hops: typeof doc.hops === "number" ? doc.hops : 2,
      distances,
    };
  }

  /**
   * `PUT /upload` (BUD-02) with an authorization made by `key`. Returns the
   * URL the blob is served from.
   */
  async upload(
    key: PersonaKey,
    blob: {
      readonly bytes: Uint8Array;
      readonly type: string;
      readonly sha256: string;
    },
  ): Promise<string> {
    const response = await this.#fetch(new URL("/upload", this.#base), {
      method: "PUT",
      headers: {
        "Content-Type": blob.type,
        Authorization: blossomAuthorization(key, blob.sha256),
      },
      body: new Blob([blob.bytes as Uint8Array<ArrayBuffer>], {
        type: blob.type,
      }),
    });
    if (!response.ok) {
      throw new Error(`upload refused: ${await refusal(response)}`);
    }
    const doc = await response.json() as { url?: unknown };
    if (typeof doc.url !== "string") {
      throw new Error("upload answer has no url");
    }
    return doc.url;
  }

  async #json(
    path: string,
    init: RequestInit = {},
  ): Promise<Record<string, unknown>> {
    const response = await this.#fetch(new URL(path, this.#base), init);
    if (!response.ok) {
      throw new Error(
        `${path} answered ${response.status}: ${await refusal(response)}`,
      );
    }
    return await response.json() as Record<string, unknown>;
  }

  async #fetch(url: URL, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (error) {
      throw new NodeUnreachableError(
        `${url.origin} did not answer: ${messageOf(error)}`,
      );
    }
  }
}

/** The `Authorization` header of a BUD-02 upload of the blob `sha256`. */
export function blossomAuthorization(
  key: PersonaKey,
  sha256: string,
  now: number = Math.floor(Date.now() / 1000),
): string {
  const event = finalizeEvent({
    kind: 24242,
    created_at: now,
    tags: [
      ["t", "upload"],
      ["x", sha256],
      ["expiration", String(now + AUTH_LIFETIME_SECONDS)],
    ],
    content: "upload",
  }, key.secretKey);
  return `Nostr ${encodeBase64(JSON.stringify(event))}`;
}

/** One WebSocket to a relay, with several events in flight at once. */
export class RelaySession {
  readonly #socket: WebSocket;
  readonly #pending = new Map<
    string,
    {
      resolve: (outcome: PublishOutcome) => void;
      reject: (error: Error) => void;
    }
  >();
  #open = true;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.onmessage = (message) => this.#receive(message.data);
    socket.onclose = () => {
      this.#open = false;
      for (const waiter of this.#pending.values()) {
        waiter.reject(new Error("the relay closed the connection"));
      }
      this.#pending.clear();
    };
  }

  /** Opens a connection to `url`, or fails after `timeoutMs`. */
  static connect(
    url: string,
    timeoutMs = HTTP_TIMEOUT_MS,
  ): Promise<RelaySession> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new NodeUnreachableError(`no relay answer from ${url}`));
      }, timeoutMs);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve(new RelaySession(socket));
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new NodeUnreachableError(`could not open ${url}`));
      };
    });
  }

  /**
   * Sends one event and resolves with the relay's `OK`. Rejects when the
   * connection drops or no answer comes within `timeoutMs`.
   */
  publish(
    event: SignedEvent,
    timeoutMs = PUBLISH_TIMEOUT_MS,
  ): Promise<PublishOutcome> {
    if (!this.#open) return Promise.reject(new Error("the relay is closed"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(event.id);
        reject(new Error("no OK from the relay in time"));
      }, timeoutMs);
      this.#pending.set(event.id, {
        resolve: (outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#socket.send(JSON.stringify(["EVENT", event]));
    });
  }

  /** Closes the connection. */
  close(): void {
    this.#open = false;
    this.#socket.close();
  }

  #receive(data: unknown): void {
    let message: unknown;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!Array.isArray(message) || message[0] !== "OK") return;
    const [, id, ok, text] = message;
    if (typeof id !== "string") return;
    const waiter = this.#pending.get(id);
    if (!waiter) return;
    this.#pending.delete(id);
    waiter.resolve({
      ok: ok === true,
      message: typeof text === "string" ? text : "",
    });
  }
}

/**
 * Applies `fn` to every item, with at most `limit` calls running at once. The
 * results keep the order of `items`.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/** The text of an error, for a message. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function refusal(response: Response): Promise<string> {
  const text = (await response.text().catch(() => "")).trim();
  return text === "" ? String(response.status) : text.slice(0, 200);
}
