/**
 * Tuning knobs of the replicator. The defaults are what production runs with;
 * tests shrink the timings to a few milliseconds.
 * @module
 */

/** Optional tuning for {@link createReplicator}; `main.ts` passes none. */
export interface ReplicatorOptions {
  /** Wait after a graph or relay-list change before replanning. Default 3000 ms. */
  replanDebounceMs?: number;
  /** First reconnect delay; doubles with every failure. Default 5000 ms. */
  backoffBaseMs?: number;
  /** Longest reconnect delay. Default 300000 ms (5 minutes). */
  backoffMaxMs?: number;
  /** Consecutive failures after which a relay is left out of the plan. Default 5. */
  maxFailures?: number;
  /** How long a relay that keeps failing stays out of the plan. Default 600000 ms. */
  excludeMs?: number;
  /** Authors per filter. Default 100. */
  authorsPerFilter?: number;
  /** Open subscriptions per relay, live and backfill together. Default 8. */
  maxSubscriptions?: number;
  /** `limit` of each backfill request. Default 500. */
  pageSize?: number;
  /** Give up on a backfill request that gets no EOSE. Default 30000 ms. */
  pageTimeoutMs?: number;
  /** Give up on a WebSocket that does not open. Default 10000 ms. */
  connectTimeoutMs?: number;
  /** A connection that lasted this long counts as healthy. Default 30000 ms. */
  stableMs?: number;
  /**
   * Seconds re-requested before the end of already covered time, and by which
   * a live subscription starts before "now". Absorbs events that reach a relay
   * late. Default 60.
   */
  overlapSeconds?: number;
  /** Debounce for writing `sync-state.json`. Default 5000 ms. */
  stateFlushMs?: number;
  /** Per-relay timeout of `publish`, connecting included. Default 5000 ms. */
  publishTimeoutMs?: number;
}

/** {@link ReplicatorOptions} with every default filled in. */
export type ResolvedOptions = Required<ReplicatorOptions>;

/** Fill in the defaults. */
export function resolveOptions(
  options: ReplicatorOptions = {},
): ResolvedOptions {
  return {
    replanDebounceMs: options.replanDebounceMs ?? 3000,
    backoffBaseMs: options.backoffBaseMs ?? 5000,
    backoffMaxMs: options.backoffMaxMs ?? 5 * 60 * 1000,
    maxFailures: options.maxFailures ?? 5,
    excludeMs: options.excludeMs ?? 10 * 60 * 1000,
    authorsPerFilter: options.authorsPerFilter ?? 100,
    maxSubscriptions: options.maxSubscriptions ?? 8,
    pageSize: options.pageSize ?? 500,
    pageTimeoutMs: options.pageTimeoutMs ?? 30000,
    connectTimeoutMs: options.connectTimeoutMs ?? 10000,
    stableMs: options.stableMs ?? 30000,
    overlapSeconds: options.overlapSeconds ?? 60,
    stateFlushMs: options.stateFlushMs ?? 5000,
    publishTimeoutMs: options.publishTimeoutMs ?? 5000,
  };
}
