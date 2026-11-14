/**
 * The node's own state as signals: `/api/status` and `/api/graph`.
 *
 * Call {@link loadNode} once at start: it fetches both and refreshes the status
 * on every navigation. A view that shows live replication calls
 * {@link watchStatus} while it is mounted, which polls every five seconds.
 * Every fetch tolerates an unreachable node.
 *
 * @module
 */
import { computed, effect, signal } from "@preact/signals";
import { getGraph, getStatus, type NodeGraph, type NodeStatus } from "./api.ts";
import { route } from "./router.tsx";
import { session } from "./session.ts";

/** How often the status is polled while a view watches it, in milliseconds. */
export const POLL_MS = 5000;

/** Latest status, or `null` while unknown or unavailable. */
export const status = signal<NodeStatus | null>(null);
/** Latest social graph, or `null` while unknown or unavailable. */
export const graph = signal<NodeGraph | null>(null);
/** Error message of the last failed status fetch, if any. */
export const nodeError = signal<string | null>(null);
/** True during the first fetch. */
export const nodeLoading = signal(false);

/** Hex pubkey of the node's owner, or `null` (unknown or not set up). */
export const ownerPubkey = computed<string | null>(() =>
  status.value?.owner ?? graph.value?.owner ?? null
);

/** Whether the node still needs its first-run setup (known from the status). */
export const setupRequired = computed(() =>
  status.value?.setupRequired === true
);

/**
 * Whether the signed-in identity is the node's owner. Says nothing about
 * whether it can sign; see `canSign` in `session.ts` for that.
 */
export const isOwner = computed(() => {
  const owner = ownerPubkey.value;
  return owner !== null && session.value?.pubkey === owner;
});

/** Fetch `/api/status` again. Never throws. */
export async function refreshStatus(): Promise<void> {
  try {
    status.value = await getStatus();
    nodeError.value = null;
  } catch (error) {
    nodeError.value = (error as Error).message;
  }
}

/** Fetch `/api/graph` again. Never throws. */
export async function refreshGraph(): Promise<void> {
  try {
    graph.value = await getGraph();
  } catch {
    // leave the previous graph in place
  }
}

/** Fetch status and graph. Never throws. */
export async function loadNode(): Promise<void> {
  nodeLoading.value = true;
  await Promise.all([refreshStatus(), refreshGraph()]);
  nodeLoading.value = false;
  observeNavigation();
}

let watchers = 0;
let timer: ReturnType<typeof setInterval> | undefined;

/**
 * Poll the status (and graph) every {@link POLL_MS} while the returned
 * function has not been called. Calls nest: polling stops when the last
 * watcher stops.
 *
 * @returns A function that stops this watcher.
 */
export function watchStatus(): () => void {
  watchers++;
  if (watchers === 1) {
    void refreshStatus();
    timer = setInterval(() => {
      void refreshStatus();
      void refreshGraph();
    }, POLL_MS);
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    watchers--;
    if (watchers === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

let navigationObserved = false;

/** Refresh the status whenever the route changes (once per page load). */
function observeNavigation(): void {
  if (navigationObserved) return;
  navigationObserved = true;
  let first = true;
  effect(() => {
    void route.value.pathname;
    if (first) {
      first = false;
      return;
    }
    void refreshStatus();
  });
}

/**
 * Follow-hop distance of `pubkey` from the owner (0 = the owner), or
 * `undefined` when outside the replicated neighbourhood or unknown. Reads a
 * signal, so components using it re-render when the graph arrives.
 */
export function distanceOf(pubkey: string): number | undefined {
  return graph.value?.distances[pubkey];
}

/**
 * Authors per distance as a list of `{ hop, count }`, for the hops that have
 * any authors, in ascending order of distance.
 */
export function hopCounts(
  s: NodeStatus | null = status.value,
): { hop: number; count: number }[] {
  return (s?.authorsByHop ?? []).flatMap((count, hop) =>
    count > 0 ? [{ hop, count }] : []
  );
}
