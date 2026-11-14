/**
 * "Your habitat": the node at a glance, shown in the right rail.
 *
 * @module
 */
import { Server } from "lucide-preact";
import { formatCount } from "../lib/format.ts";
import {
  hopCounts,
  nodeError,
  nodeLoading,
  ownerPubkey,
  refreshStatus,
  status,
} from "../lib/node.ts";
import { Link } from "../lib/router.tsx";
import { AuthorName } from "./AuthorName.tsx";
import { hopLabel } from "./HopBadge.tsx";
import { Skeleton } from "./Spinner.tsx";

/** Node name, owner, authors per hop as a stacked bar, event count. */
export function HabitatCard() {
  const s = status.value;
  const counts = hopCounts(s);
  const total = counts.reduce((n, c) => n + c.count, 0);
  const owner = ownerPubkey.value;

  return (
    <section class="card habitat" aria-labelledby="habitat-title">
      <header class="habitat__header">
        <Server size={18} aria-hidden="true" />
        <h2 id="habitat-title" class="habitat__title">Your habitat</h2>
      </header>
      {!s && nodeLoading.value && <Skeleton count={3} />}
      {!s && !nodeLoading.value && (
        <p class="muted habitat__unavailable">
          The node is not answering{nodeError.value
            ? ` (${nodeError.value})`
            : ""}.{" "}
          <button type="button" class="link-button" onClick={refreshStatus}>
            Retry
          </button>
        </p>
      )}
      {s && (
        <>
          <div>
            <p class="habitat__name">{s.name}</p>
            {s.description && (
              <p class="muted habitat__desc">{s.description}</p>
            )}
          </div>
          <dl class="habitat__facts">
            <div>
              <dt>Owner</dt>
              <dd>
                {owner
                  ? (
                    <AuthorName
                      pubkey={owner}
                      showNip05={false}
                      showHops={false}
                    />
                  )
                  : <Link to="/settings">not set up yet</Link>}
              </dd>
            </div>
            <div>
              <dt>Events</dt>
              <dd>
                {s.stats?.events !== undefined
                  ? formatCount(s.stats.events)
                  : "–"}
              </dd>
            </div>
          </dl>
          {total > 0 && (
            <div class="habitat__hops">
              <div
                class="hopbar"
                role="img"
                aria-label={`Authors by distance: ${
                  counts.map((c) => `${c.count} ${hopLabel(c.hop)}`).join(", ")
                }`}
              >
                {counts.map((c) => (
                  <span
                    key={c.hop}
                    class={`hopbar__seg hopbar__seg--${Math.min(c.hop, 3)}`}
                    style={{ flexGrow: c.count }}
                  />
                ))}
              </div>
              <ul class="hopbar__legend">
                {counts.map((c) => (
                  <li key={c.hop}>
                    <span
                      class={`hop-badge__dot hop-badge__dot--${
                        Math.min(c.hop, 3)
                      }`}
                    />
                    {hopLabel(c.hop)} <strong>{formatCount(c.count)}</strong>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
