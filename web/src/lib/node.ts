/**
 * The node's own state as signals: `/api/status` and `/api/graph`.
 * Call {@link loadNode} once at start; both calls tolerate an unreachable node.
 *
 * @module
 */
import { computed, signal } from "@preact/signals";
import { getGraph, getStatus, type NodeGraph, type NodeStatus } from "./api.ts";

/** Latest status, or `null` while unknown or unavailable. */
export const status = signal<NodeStatus | null>(null);
/** Latest social graph, or `null` while unknown or unavailable. */
export const graph = signal<NodeGraph | null>(null);
/** Error message of the last failed status fetch, if any. */
export const nodeError = signal<string | null>(null);
/** True during the first fetch. */
export const nodeLoading = signal(false);

/** Hex pubkey of the node's owner, if known. */
export const ownerPubkey = computed(() =>
  status.value?.owner ?? graph.value?.owner ?? null
);

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
}

/**
 * Follow-hop distance of `pubkey` from the owner (0 = the owner), or
 * `undefined` when outside the replicated neighbourhood or unknown. Reads a
 * signal, so components using it re-render when the graph arrives.
 */
export function distanceOf(pubkey: string): number | undefined {
  return graph.value?.distances[pubkey];
}

/** Authors per hop as a sorted list, from either shape the API may use. */
export function hopCounts(
  s: NodeStatus | null = status.value,
): { hop: number; count: number }[] {
  const raw = s?.authorsByHop;
  if (!raw) return [];
  const entries = Array.isArray(raw)
    ? raw.map((count, hop) => [hop, count] as const)
    : Object.entries(raw).map(([hop, count]) => [Number(hop), count] as const);
  return entries
    .filter(([hop, count]) => Number.isFinite(hop) && Number(count) > 0)
    .map(([hop, count]) => ({ hop, count: Number(count) }))
    .sort((a, b) => a.hop - b.hop);
}
