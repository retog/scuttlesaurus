/**
 * The relays replication currently uses: URL, connection state, authors asked
 * for, events received, whether history is still being fetched, and the last
 * error. Stacks into a list on narrow screens.
 *
 * @module
 */
import type { RelayStatus } from "../../../src/types.ts";
import { formatCount } from "../lib/format.ts";

/** Human label and colour class for each relay state. */
export const RELAY_STATES: Record<
  RelayStatus["state"],
  { label: string; tone: string }
> = {
  connected: { label: "connected", tone: "ok" },
  connecting: { label: "connecting", tone: "pending" },
  backoff: { label: "backing off", tone: "warn" },
  closed: { label: "closed", tone: "off" },
};

/** Props of {@link RelayTable}. */
export interface RelayTableProps {
  relays: readonly RelayStatus[];
}

/** A coloured dot with the state's label. */
export function RelayState({ state }: { state: RelayStatus["state"] }) {
  const { label, tone } = RELAY_STATES[state];
  return (
    <span class={`relay-state relay-state--${tone}`}>
      <span class="relay-state__dot" aria-hidden="true" />
      {label}
    </span>
  );
}

/** Table of relays, sorted as the replicator returns them. */
export function RelayTable({ relays }: RelayTableProps) {
  return (
    <div class="relay-table-wrap">
      <table class="relay-table">
        <thead>
          <tr>
            <th scope="col">Relay</th>
            <th scope="col">State</th>
            <th scope="col" class="num">Authors</th>
            <th scope="col" class="num">Events</th>
          </tr>
        </thead>
        <tbody>
          {relays.map((relay) => (
            <tr key={relay.url}>
              <td data-label="Relay" class="relay-table__url">
                <span class="mono" title={relay.url}>{relay.url}</span>
                {relay.backfilling && (
                  <span class="relay-table__history">fetching history…</span>
                )}
                {relay.lastError && (
                  <span
                    class="relay-table__error muted"
                    title={relay.lastError}
                  >
                    {relay.lastError}
                  </span>
                )}
              </td>
              <td data-label="State">
                <RelayState state={relay.state} />
              </td>
              <td data-label="Authors" class="num">
                {formatCount(relay.authors)}
              </td>
              <td data-label="Events" class="num">
                {formatCount(relay.eventsReceived)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
