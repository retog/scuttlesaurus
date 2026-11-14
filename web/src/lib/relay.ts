/**
 * One shared, auto-reconnecting WebSocket to the node's own relay (NIP-01).
 *
 * The connection is opened lazily by the first call and kept open. Live
 * subscriptions are re-sent after a reconnect.
 *
 * @module
 */
import { signal } from "@preact/signals";
import type { Event } from "@nostr/tools/core";
import type { Filter } from "@nostr/tools/filter";

export type { Event, Filter };

/** Connection state of the relay socket. */
export type RelayState = "idle" | "connecting" | "open" | "closed";

/** Current connection state (`closed` means: waiting to reconnect). */
export const relayState = signal<RelayState>("idle");

/** URL of the node's relay: same host as the page. */
export function relayUrl(): string {
  const { protocol, host } = globalThis.location;
  return `${protocol === "https:" ? "wss" : "ws"}://${host}/`;
}

interface Subscription {
  filters: Filter[];
  onEvent: (event: Event) => void;
  onEose?: () => void;
  onClosed?: (reason: string) => void;
}

interface PendingOk {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let socket: WebSocket | undefined;
let attempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let counter = 0;
const subscriptions = new Map<string, Subscription>();
const pendingOk = new Map<string, PendingOk>();
const openWaiters = new Set<() => void>();

function send(message: unknown[]): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

/** Open the connection now (it is otherwise opened by the first use). */
export function connect(): void {
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  clearTimeout(reconnectTimer);
  relayState.value = "connecting";
  let ws: WebSocket;
  try {
    ws = new WebSocket(relayUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  socket = ws;
  ws.onopen = () => {
    attempts = 0;
    relayState.value = "open";
    for (const [id, sub] of subscriptions) send(["REQ", id, ...sub.filters]);
    for (const wake of [...openWaiters]) wake();
    openWaiters.clear();
  };
  ws.onmessage = (message) => {
    let data: unknown;
    try {
      data = JSON.parse(String(message.data));
    } catch {
      return;
    }
    if (Array.isArray(data)) handle(data);
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = undefined;
    relayState.value = "closed";
    scheduleReconnect();
  };
  ws.onerror = () => {
    // onclose follows; nothing to do here
  };
}

function scheduleReconnect(): void {
  if (
    subscriptions.size === 0 && pendingOk.size === 0 &&
    openWaiters.size === 0 && attempts > 0
  ) {
    // Nobody is waiting: stay down until the next use.
    relayState.value = "closed";
    return;
  }
  attempts++;
  const delay = Math.min(30_000, 500 * 2 ** Math.min(attempts, 6));
  reconnectTimer = setTimeout(connect, delay);
}

function handle(data: unknown[]): void {
  const [type, a, b, c] = data as [string, string, unknown, unknown];
  if (type === "EVENT") {
    subscriptions.get(a)?.onEvent(b as Event);
  } else if (type === "EOSE") {
    subscriptions.get(a)?.onEose?.();
  } else if (type === "OK") {
    const pending = pendingOk.get(a);
    if (!pending) return;
    pendingOk.delete(a);
    clearTimeout(pending.timer);
    if (b === true) pending.resolve();
    else pending.reject(new Error(String(c || "rejected by relay")));
  } else if (type === "CLOSED") {
    const sub = subscriptions.get(a);
    if (sub) {
      subscriptions.delete(a);
      sub.onClosed?.(String(b ?? "closed by relay"));
    }
  }
}

function whenOpen(timeoutMs: number): Promise<void> {
  if (socket?.readyState === WebSocket.OPEN) return Promise.resolve();
  connect();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      openWaiters.delete(wake);
      reject(new Error("Relay unreachable"));
    }, timeoutMs);
    const wake = () => {
      clearTimeout(timer);
      resolve();
    };
    openWaiters.add(wake);
  });
}

/**
 * Publish a signed event. Resolves on `OK true`; rejects with the relay's
 * message on `OK false` and with an error on timeout (default 10 s).
 */
export async function publish(event: Event, timeoutMs = 10_000): Promise<void> {
  await whenOpen(timeoutMs);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingOk.delete(event.id);
      reject(new Error("Relay did not answer in time"));
    }, timeoutMs);
    pendingOk.set(event.id, { resolve, reject, timer });
    if (!send(["EVENT", event])) {
      clearTimeout(timer);
      pendingOk.delete(event.id);
      reject(new Error("Relay connection lost"));
    }
  });
}

/**
 * Keep a live subscription. `onEvent` receives stored events first, then new
 * ones; `onEose` fires after the stored ones (again after each reconnect).
 * Returns the function that closes the subscription.
 */
export function subscribe(
  filters: Filter[],
  onEvent: (event: Event) => void,
  options: { onEose?: () => void; onClosed?: (reason: string) => void } = {},
): () => void {
  const id = `s${++counter}`;
  subscriptions.set(id, { filters, onEvent, ...options });
  if (socket?.readyState === WebSocket.OPEN) send(["REQ", id, ...filters]);
  else connect();
  return () => {
    if (subscriptions.delete(id)) send(["CLOSE", id]);
  };
}

/**
 * Collect the stored events matching `filters` (until EOSE). Rejects when the
 * relay closes the subscription or does not answer within `timeoutMs`
 * (default 10 s).
 */
export function fetchEvents(
  filters: Filter[],
  timeoutMs = 10_000,
): Promise<Event[]> {
  return new Promise((resolve, reject) => {
    const events = new Map<string, Event>();
    const finish = (error?: Error) => {
      clearTimeout(timer);
      close();
      if (error) reject(error);
      else resolve([...events.values()]);
    };
    const timer = setTimeout(
      () => finish(new Error("Relay did not answer in time")),
      timeoutMs,
    );
    const close = subscribe(
      filters,
      (event) => events.set(event.id, event),
      {
        onEose: () => finish(),
        onClosed: (reason) => finish(new Error(reason)),
      },
    );
  });
}
