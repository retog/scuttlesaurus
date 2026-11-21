/**
 * The transport of NIP-46 "Nostr Connect" for the browser: kind 24133 events,
 * NIP-44-encrypted, exchanged with a remote signer over one or more relays.
 *
 * It replaces the `BunkerSigner` of `@nostr/tools`, whose listening cannot
 * survive a phone: it subscribes with `limit: 0` (nothing that was sent
 * earlier is ever delivered), and when the browser is pushed to the background
 * while the person is in the signer app, the signer's answer is sent while
 * nobody is subscribed and is lost. This channel keeps its own sockets and,
 * when a socket closes, the page becomes visible again or the network returns,
 * re-subscribes with a `since` that covers the gap, so an answer sent
 * meanwhile is picked up from a relay that keeps it for a moment (this node's
 * relay does, for two minutes). It never resends a request because of that.
 *
 * Every step is reported to `log` in plain words for the person to read on a
 * phone: no secrets and no decrypted payloads, ever.
 *
 * @module
 */
import type { Event } from "@nostr/tools/core";
import { decrypt, encrypt, getConversationKey } from "@nostr/tools/nip44";
import { finalizeEvent, getPublicKey, verifyEvent } from "@nostr/tools/pure";

/** Kind of NIP-46 request and response events. */
const NOSTR_CONNECT = 24133;

/** Seconds subtracted from the last time a socket was alive when re-subscribing. */
const LOOKBACK_MARGIN_S = 60;
/** The furthest back a re-subscription looks, in seconds. */
const MAX_LOOKBACK_S = 5 * 60;
/**
 * How long this node's relay keeps a Nostr Connect message for a client that
 * was not subscribed. A gap longer than this may have lost an answer.
 */
export const RELAY_KEEPS_SECONDS = 120;
/** How long a request waits for an open connection, in milliseconds. */
const SEND_WAIT_MS = 8_000;
/** How long a relay may take to answer `OK`, in milliseconds. */
const OK_WAIT_MS = 5_000;
/** Time a pending request gets after the page becomes visible again. */
const VISIBLE_GRACE_MS = 20_000;
/** How long a request waits after the signer asked the person to open a page. */
export const AUTH_TIMEOUT_MS = 5 * 60_000;

/** Why a request failed. */
export type Nip46ErrorKind =
  /** No answer in time. */
  | "timeout"
  /** The request did not leave this page: no connection, or every relay refused. */
  | "send"
  /** The signer answered with an error. */
  | "rejected"
  /** The channel was closed. */
  | "closed";

/** A failed NIP-46 request. `message` is the raw reason; callers explain it. */
export class Nip46Error extends Error {
  constructor(readonly kind: Nip46ErrorKind, message: string) {
    super(message);
    this.name = "Nip46Error";
  }
}

/** Options of {@link Nip46Channel}. */
export interface Nip46ChannelOptions {
  /** This browser's connection key (not the user's). */
  clientSecret: Uint8Array;
  relays: string[];
  /** The signer's pubkey, if known. Otherwise use {@link Nip46Channel.awaitConnect}. */
  peer?: string;
  /** Receives each step, in plain words. */
  log: (text: string) => void;
  /** Called with the page a signer asks the person to open (`auth_url`). */
  onAuth?: (url: string) => void;
  /** Seconds since the epoch from which the first subscription looks back. */
  since?: number;
  /**
   * Called when a relay is reached again after the page was away for longer
   * than relays keep messages ({@link RELAY_KEEPS_SECONDS}), once the relay
   * has sent what it kept. An answer sent in that time may be lost.
   */
  onGap?: (seconds: number) => void;
}

interface Connection {
  url: string;
  host: string;
  ws?: WebSocket;
  open: boolean;
  attempts: number;
  /** Seconds since the epoch at which the socket was last known to be alive. */
  alive: number;
  retry?: ReturnType<typeof setTimeout>;
  /** Whether it has ever been open. */
  everOpen: boolean;
  /** Seconds the page was away before the last reconnection, if long. */
  gap?: number;
}

interface Pending {
  resolve: (value: string) => void;
  reject: (error: Nip46Error) => void;
  method: string;
  deadline: number;
  authed: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function randomId(): string {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(8)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

/** One NIP-46 conversation with a remote signer over some relays. */
export class Nip46Channel {
  readonly #secret: Uint8Array;
  readonly #pubkey: string;
  readonly #log: (text: string) => void;
  readonly #onAuth?: (url: string) => void;
  readonly #onGap?: (seconds: number) => void;
  readonly #connections: Connection[];
  readonly #subId = `nc-${randomId()}`;
  readonly #seen = new Set<string>();
  readonly #pending = new Map<string, Pending>();
  readonly #okWaiters = new Map<
    string,
    { ok: () => void; refused: (reason: string) => void }
  >();
  readonly #openWaiters = new Set<() => void>();
  #peer: string | undefined;
  #conversationKey: Uint8Array | undefined;
  #connectWait:
    | { secret: string; resolve: (pubkey: string) => void }
    | undefined;
  #closed = false;
  #hiddenAt: number | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #since: number;
  #unlisten: (() => void) | undefined;

  constructor(options: Nip46ChannelOptions) {
    this.#secret = options.clientSecret;
    this.#pubkey = getPublicKey(options.clientSecret);
    this.#log = options.log;
    this.#onAuth = options.onAuth;
    this.#onGap = options.onGap;
    this.#since = options.since ?? nowSeconds();
    this.#connections = [...new Set(options.relays)].map((url) => ({
      url,
      host: hostOf(url),
      open: false,
      attempts: 0,
      alive: this.#since,
      everOpen: false,
    }));
    if (options.peer) this.setPeer(options.peer);
  }

  /** The signer's pubkey, once known. */
  get peer(): string | undefined {
    return this.#peer;
  }

  /** Whether any relay connection is open now. */
  get connected(): boolean {
    return this.#connections.some((c) => c.open);
  }

  /** Whether a relay connection has been open at some point. */
  get everConnected(): boolean {
    return this.#connections.some((c) => c.everOpen);
  }

  /** Fixes the signer's pubkey; messages from other keys are then ignored. */
  setPeer(pubkey: string): void {
    this.#peer = pubkey;
    this.#conversationKey = getConversationKey(this.#secret, pubkey);
  }

  /** Opens the connections and starts listening. */
  start(): void {
    for (const connection of this.#connections) this.#connect(connection);
    this.#heartbeat = setInterval(() => {
      // While the page runs, "alive" moves on; when it is frozen it stops, so
      // the gap to look back over is the time the page was not running.
      for (const c of this.#connections) {
        if (c.open && c.ws?.readyState === WebSocket.OPEN) {
          c.alive = nowSeconds();
        }
      }
    }, 15_000);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        this.#hiddenAt = Date.now();
        this.#log("page went to the background");
        return;
      }
      const away = this.#hiddenAt === undefined
        ? 0
        : Math.round((Date.now() - this.#hiddenAt) / 1000);
      this.#hiddenAt = undefined;
      this.#log(`page visible again after ${away} s: reconnecting`);
      this.#extendDeadlines();
      this.#reconnectAll();
    };
    const onOnline = () => {
      this.#log("network is back: reconnecting");
      this.#reconnectAll();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) onOnline();
    };
    document.addEventListener("visibilitychange", onVisibility);
    globalThis.addEventListener("online", onOnline);
    globalThis.addEventListener("pageshow", onPageShow);
    this.#unlisten = () => {
      document.removeEventListener("visibilitychange", onVisibility);
      globalThis.removeEventListener("online", onOnline);
      globalThis.removeEventListener("pageshow", onPageShow);
    };
  }

  /**
   * Waits for the signer's answer to a `nostrconnect://` link: a message from
   * any key, addressed to this client, whose `result` is `secret`. That is
   * what shows the signer saw the link. Resolves with the signer's pubkey and
   * makes it the peer. An answer of `"ack"` or with another result is not
   * accepted: in this flow the secret is the proof.
   */
  awaitConnect(secret: string, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.#connectWait = undefined;
        reject(new Nip46Error("closed", "cancelled"));
      };
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      this.#connectWait = {
        secret,
        resolve: (pubkey) => {
          signal.removeEventListener("abort", abort);
          this.#connectWait = undefined;
          resolve(pubkey);
        },
      };
    });
  }

  /**
   * Sends a NIP-46 request and waits for its answer. The wait is not counted
   * while the page is in the background (it gets a grace period when it comes
   * back), because that is where the person is approving.
   */
  async request(
    method: string,
    params: string[],
    timeoutMs: number,
  ): Promise<string> {
    if (this.#closed) throw new Nip46Error("closed", "the channel is closed");
    if (!this.#peer || !this.#conversationKey) {
      throw new Nip46Error("send", "the signer is not known yet");
    }
    const id = randomId();
    const event = finalizeEvent({
      kind: NOSTR_CONNECT,
      created_at: nowSeconds(),
      tags: [["p", this.#peer]],
      content: encrypt(
        JSON.stringify({ id, method, params }),
        this.#conversationKey,
      ),
    }, this.#secret);
    const answer = new Promise<string>((resolve, reject) => {
      const pending: Pending = {
        resolve,
        reject,
        method,
        deadline: Date.now() + timeoutMs,
        authed: false,
      };
      this.#pending.set(id, pending);
      this.#arm(id, pending);
    });
    // The answer may fail before we await it; do not leave it unhandled.
    answer.catch(() => {});
    try {
      await this.#publish(event);
    } catch (error) {
      this.#settle(id)?.reject(error as Nip46Error);
    }
    return answer;
  }

  /** Closes every connection and fails the requests still waiting. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unlisten?.();
    clearInterval(this.#heartbeat);
    this.#connectWait = undefined;
    for (const id of [...this.#pending.keys()]) {
      this.#settle(id)?.reject(
        new Nip46Error("closed", "the channel was closed"),
      );
    }
    for (const c of this.#connections) {
      clearTimeout(c.retry);
      this.#drop(c);
    }
    for (const wake of [...this.#openWaiters]) wake();
  }

  // --- connections ---------------------------------------------------------

  #connect(c: Connection): void {
    if (this.#closed) return;
    clearTimeout(c.retry);
    let ws: WebSocket;
    try {
      ws = new WebSocket(c.url);
    } catch {
      this.#log(`cannot open ${c.host}: not a usable relay address`);
      return;
    }
    c.ws = ws;
    ws.onopen = () => {
      if (c.ws !== ws) return;
      const away = nowSeconds() - c.alive;
      c.gap = c.everOpen && away > RELAY_KEEPS_SECONDS ? away : undefined;
      c.open = true;
      c.everOpen = true;
      c.attempts = 0;
      const since = Math.max(
        c.alive - LOOKBACK_MARGIN_S,
        nowSeconds() - MAX_LOOKBACK_S,
        0,
      );
      this.#log(`relay connected: ${c.host}`);
      ws.send(JSON.stringify([
        "REQ",
        this.#subId,
        { kinds: [NOSTR_CONNECT], "#p": [this.#pubkey], since },
      ]));
      this.#log(
        `subscribed on ${c.host}, looking back ${nowSeconds() - since} s`,
      );
      c.alive = nowSeconds();
      for (const wake of [...this.#openWaiters]) wake();
    };
    ws.onmessage = (message) => {
      if (c.ws !== ws) return;
      c.alive = nowSeconds();
      this.#onFrame(c, message.data);
    };
    ws.onclose = () => {
      if (c.ws !== ws) return;
      const wasOpen = c.open;
      c.open = false;
      c.ws = undefined;
      if (wasOpen) this.#log(`connection to ${c.host} closed`);
      else if (!c.everOpen || c.attempts === 0) {
        this.#log(`could not connect to ${c.host}`);
      }
      this.#scheduleRetry(c);
    };
    ws.onerror = () => {
      // onclose follows
    };
  }

  #scheduleRetry(c: Connection): void {
    if (this.#closed) return;
    c.attempts++;
    const delay = Math.min(10_000, 500 * 2 ** Math.min(c.attempts, 5));
    clearTimeout(c.retry);
    c.retry = setTimeout(() => this.#connect(c), delay);
  }

  /** Closes a socket without triggering its own retry logic. */
  #drop(c: Connection): void {
    const ws = c.ws;
    c.ws = undefined;
    c.open = false;
    if (ws) {
      ws.onopen =
        ws.onmessage =
        ws.onclose =
        ws.onerror =
          null;
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
  }

  /**
   * A socket that looks open may be dead after the page was frozen, and a
   * closed one waits for its retry timer: replace every socket now. What was
   * sent meanwhile comes back through the `since` of the new subscription.
   */
  #reconnectAll(): void {
    if (this.#closed) return;
    for (const c of this.#connections) {
      this.#drop(c);
      c.attempts = 0;
      this.#connect(c);
    }
  }

  // --- messages ------------------------------------------------------------

  #onFrame(c: Connection, data: unknown): void {
    let frame: unknown;
    try {
      frame = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!Array.isArray(frame)) return;
    const [type, a, b, d] = frame as unknown[];
    if (type === "EVENT" && a === this.#subId) {
      this.#onEvent(c, b as Event);
    } else if (type === "EOSE" && a === this.#subId) {
      this.#log(`${c.host} has sent what it had kept`);
      if (c.gap !== undefined) {
        const gap = c.gap;
        c.gap = undefined;
        this.#log(
          `this page was away for ${gap} s, longer than relays keep answers`,
        );
        this.#onGap?.(gap);
      }
    } else if (type === "OK" && typeof a === "string") {
      const waiter = this.#okWaiters.get(a);
      if (!waiter) return;
      if (b === true) waiter.ok();
      else waiter.refused(String(d ?? "refused").slice(0, 120));
    } else if (type === "CLOSED" && a === this.#subId) {
      this.#log(`${c.host} closed the subscription: ${String(b).slice(0, 80)}`);
    } else if (type === "NOTICE") {
      this.#log(`${c.host} says: ${String(a).slice(0, 80)}`);
    }
  }

  #onEvent(c: Connection, event: Event): void {
    if (!event || typeof event.id !== "string" || this.#seen.has(event.id)) {
      return;
    }
    this.#seen.add(event.id);
    if (this.#seen.size > 500) {
      this.#seen.delete(this.#seen.values().next().value as string);
    }
    this.#log(`a message arrived from ${c.host}`);
    let valid = false;
    try {
      valid = event.kind === NOSTR_CONNECT && verifyEvent(event);
    } catch {
      valid = false;
    }
    if (!valid) return this.#log("message could not be read: bad signature");
    if (!event.tags.some((t) => t[0] === "p" && t[1] === this.#pubkey)) {
      return this.#log("message could not be read: not for this client");
    }
    if (this.#peer && event.pubkey !== this.#peer) {
      return this.#log("message ignored: not from the connected signer");
    }
    const payload = this.#read(event);
    if (!payload) return;

    if (this.#connectWait && !this.#peer) {
      if (payload.result === this.#connectWait.secret) {
        this.#log("signer connected");
        const { resolve } = this.#connectWait;
        this.setPeer(event.pubkey);
        resolve(event.pubkey);
      } else if (payload.result === "ack") {
        this.#log(
          'message refused: the signer answered "ack", not the secret from the link',
        );
      } else {
        this.#log(
          "message could not be read: answer does not carry our secret",
        );
      }
      return;
    }
    this.#answer(payload);
  }

  /** Decrypts and parses; logs the reason when it cannot. */
  #read(
    event: Event,
  ): { id?: string; result?: string; error?: string } | undefined {
    try {
      const key = this.#conversationKey ??
        getConversationKey(this.#secret, event.pubkey);
      const parsed = JSON.parse(decrypt(event.content, key));
      if (typeof parsed === "object" && parsed !== null) return parsed;
      this.#log("message could not be read: unexpected content");
    } catch {
      this.#log(
        /\?iv=/.test(event.content)
          ? "message could not be read: encrypted with NIP-04, which is not supported"
          : "message could not be read: could not decrypt it",
      );
    }
    return undefined;
  }

  #answer(payload: { id?: string; result?: string; error?: string }): void {
    const { id, result, error } = payload;
    const pending = typeof id === "string" ? this.#pending.get(id) : undefined;
    if (!id || !pending) return;
    if (result === "auth_url" && !pending.authed) {
      pending.authed = true;
      pending.deadline = Date.now() + AUTH_TIMEOUT_MS;
      this.#arm(id, pending);
      this.#log("the signer asks you to open a page");
      this.#onAuth?.(error ?? "");
      return;
    }
    if (error !== undefined && error !== null) {
      this.#log(`answer to ${pending.method}: refused by the signer`);
      this.#settle(id)?.reject(new Nip46Error("rejected", String(error)));
    } else if (result !== undefined && result !== null) {
      this.#log(`answer to ${pending.method} received`);
      this.#settle(id)?.resolve(result);
    } else {
      this.#settle(id)?.reject(
        new Nip46Error("rejected", "the answer has neither result nor error"),
      );
    }
  }

  // --- sending and waiting ---------------------------------------------------

  async #publish(event: Event): Promise<void> {
    if (!this.connected) {
      this.#log("waiting for a relay connection to send the request");
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          this.#openWaiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, SEND_WAIT_MS);
        this.#openWaiters.add(wake);
      });
    }
    const open = this.#connections.filter((c) => c.open && c.ws);
    if (open.length === 0) {
      throw new Nip46Error(
        "send",
        `cannot reach ${this.#connections.map((c) => c.host).join(", ")}`,
      );
    }
    const outcome = await new Promise<"ok" | "silent" | string>((resolve) => {
      let refusals = 0;
      const timer = setTimeout(() => {
        this.#okWaiters.delete(event.id);
        resolve("silent");
      }, OK_WAIT_MS);
      this.#okWaiters.set(event.id, {
        ok: () => {
          clearTimeout(timer);
          this.#okWaiters.delete(event.id);
          resolve("ok");
        },
        refused: (reason) => {
          if (++refusals < open.length) return;
          clearTimeout(timer);
          this.#okWaiters.delete(event.id);
          resolve(reason);
        },
      });
      for (const c of open) c.ws?.send(JSON.stringify(["EVENT", event]));
    });
    if (outcome === "ok") return;
    if (outcome === "silent") {
      this.#log("the relay did not confirm the request; waiting anyway");
      return;
    }
    throw new Nip46Error("send", `the relay refused the request: ${outcome}`);
  }

  #arm(id: string, pending: Pending): void {
    clearTimeout(pending.timer);
    pending.timer = setTimeout(
      () => {
        // The person is in the signer app while the page is hidden: the wait
        // does not run out then, it starts again when the page is back.
        if (document.visibilityState === "hidden") {
          pending.deadline = Math.max(
            pending.deadline,
            Date.now() + VISIBLE_GRACE_MS,
          );
        }
        if (Date.now() < pending.deadline) return this.#arm(id, pending);
        this.#settle(id)?.reject(
          new Nip46Error("timeout", `no answer to ${pending.method}`),
        );
      },
      Math.max(0, pending.deadline - Date.now()),
    );
  }

  #extendDeadlines(): void {
    for (const [id, pending] of this.#pending) {
      pending.deadline = Math.max(
        pending.deadline,
        Date.now() + VISIBLE_GRACE_MS,
      );
      this.#arm(id, pending);
    }
  }

  #settle(id: string): Pending | undefined {
    const pending = this.#pending.get(id);
    if (!pending) return undefined;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    return pending;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
