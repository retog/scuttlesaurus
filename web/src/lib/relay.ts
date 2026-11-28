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
  event: Event;
  /** Everyone waiting for this event's `OK`: true for an answer, false for none. */
  waiters: {
    resolve: (answered: boolean) => void;
    reject: (e: Error) => void;
  }[];
  timer: ReturnType<typeof setTimeout>;
}

/** A published event the relay has not confirmed after a few seconds. */
export interface SlowPublish {
  id: string;
  kind: number;
  startedAt: number;
}

/**
 * Publications that are taking long: the node may be busy writing (with the
 * QLever store, while its index is rebuilt). Shown as "still saving".
 */
export const slowPublishes = signal<SlowPublish[]>([]);

/**
 * The relay did not confirm the event in time. It may still have been
 * stored; publishing the same signed event again is safe (a duplicate is
 * answered with `OK true`) and never creates a second post.
 */
export class UnconfirmedError extends Error {
  constructor(readonly event: Event) {
    super(
      "The node has not confirmed this yet. It may still be saved; sending again will not post it twice.",
    );
    this.name = "UnconfirmedError";
  }
}

/** After this long a publication counts as slow (see {@link slowPublishes}). */
const SLOW_AFTER_MS = 4_000;
/**
 * How long a publication waits for `OK` by default: longer than the node's
 * store may take to make a write visible (120 s with qlever-dir), plus a
 * margin. The connection may drop and come back meanwhile; the event is then
 * sent again.
 */
const PUBLISH_PATIENCE_MS = 150_000;

let socket: WebSocket | undefined;
let attempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let counter = 0;
const subscriptions = new Map<string, Subscription>();
const pendingOk = new Map<string, PendingOk>();

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
    // Events sent before the connection dropped may never have arrived.
    for (const pending of pendingOk.values()) send(["EVENT", pending.event]);
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
  if (subscriptions.size === 0 && pendingOk.size === 0 && attempts > 0) {
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
    for (const waiter of pending.waiters) {
      if (b === true) waiter.resolve(true);
      else waiter.reject(new Error(String(c || "rejected by relay")));
    }
  } else if (type === "CLOSED") {
    const sub = subscriptions.get(a);
    if (sub) {
      subscriptions.delete(a);
      sub.onClosed?.(String(b ?? "closed by relay"));
    }
  }
}

/**
 * Publish a signed event. Resolves on `OK true`; rejects with the relay's
 * message on `OK false`. A relay that is slow to answer is waited for, and
 * the event is sent again after a reconnect, for up to `timeoutMs` (default
 * 150 s). Without an answer by then the node is asked whether it has the
 * event; if not, this rejects with an {@link UnconfirmedError}.
 */
export async function publish(
  event: Event,
  timeoutMs = PUBLISH_PATIENCE_MS,
): Promise<void> {
  const slow = setTimeout(() => {
    slowPublishes.value = [
      ...slowPublishes.value,
      { id: event.id, kind: event.kind, startedAt: Date.now() - SLOW_AFTER_MS },
    ];
  }, SLOW_AFTER_MS);
  try {
    const answered = await waitForOk(event, timeoutMs);
    if (!answered && !(await relayHas(event.id))) {
      throw new UnconfirmedError(event);
    }
  } finally {
    clearTimeout(slow);
    if (slowPublishes.value.some((p) => p.id === event.id)) {
      slowPublishes.value = slowPublishes.value.filter((p) =>
        p.id !== event.id
      );
    }
  }
}

/**
 * Send the event and wait for its `OK`. True on `OK true`, false when the
 * time ran out; rejects on `OK false`.
 */
function waitForOk(event: Event, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const earlier = pendingOk.get(event.id);
    if (earlier) {
      // The same event is already waiting: share its answer.
      earlier.waiters.push({ resolve, reject });
      return;
    }
    const pending: PendingOk = {
      event,
      waiters: [{ resolve, reject }],
      timer: setTimeout(() => {
        pendingOk.delete(event.id);
        for (const waiter of pending.waiters) waiter.resolve(false);
      }, timeoutMs),
    };
    pendingOk.set(event.id, pending);
    // Otherwise it is sent when the connection (re)opens.
    if (!send(["EVENT", event])) connect();
  });
}

/** Whether the node's relay returns the event with this id. */
async function relayHas(id: string): Promise<boolean> {
  try {
    return (await fetchEvents([{ ids: [id] }], 10_000)).length > 0;
  } catch {
    return false;
  }
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
