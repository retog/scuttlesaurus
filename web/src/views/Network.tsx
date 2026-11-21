/**
 * The node, explained: its habitat (who it keeps, by social distance), its
 * replication (the relays it listens to), how to connect to it, and a SPARQL
 * console over the graph. Visible to everybody; no sign-in needed.
 *
 * @module
 */
import { Network as NetworkIcon } from "lucide-preact";
import { useEffect } from "preact/hooks";
import { CopyField } from "../components/CopyField.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { HopRings } from "../components/HopRings.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { RelayTable } from "../components/RelayTable.tsx";
import { replicationSummary } from "../components/HabitatCard.tsx";
import { SparqlConsole } from "../components/SparqlConsole.tsx";
import { Skeleton } from "../components/Spinner.tsx";
import { formatCount } from "../lib/format.ts";
import { useDocumentTitle } from "../lib/hooks.ts";
import { hopCounts, nodeError, status, watchStatus } from "../lib/node.ts";
import { Link } from "../lib/router.tsx";

/** The Network view. */
export default function NetworkView() {
  useDocumentTitle("Network");
  const s = status.value;

  // Replication changes while the page is open: poll while it is shown.
  useEffect(() => watchStatus(), []);

  if (!s) {
    return (
      <div class="page network">
        <PageHeader title="Network" />
        {nodeError.value
          ? (
            <EmptyState
              title="The node is not answering"
              icon={<NetworkIcon size={36} />}
              tone="error"
            >
              {nodeError.value}. This page retries every few seconds.
            </EmptyState>
          )
          : <Skeleton count={4} />}
      </div>
    );
  }

  const counts = hopCounts(s);
  const countsByHop = s.authorsByHop;
  const relays = s.replication.relays;
  const origin = s.publicUrl.replace(/\/+$/, "");

  return (
    <div class="page network">
      <PageHeader
        title="Network"
        subtitle="The node, the people it keeps, and how it reaches them."
      />

      <section class="card net-section" aria-labelledby="net-habitat">
        <h2 id="net-habitat" class="net-section__title">Your habitat</h2>
        <p class="muted">
          The node keeps the events of everybody within {s.hops}{" "}
          {s.hops === 1 ? "hop" : "hops"}{" "}
          of its owner. Each ring is one step further away.
        </p>
        <div class="habitat-layout">
          <HopRings counts={countsByHop} hops={s.hops} />
          <div class="habitat-layout__details">
            <ul class="hop-list">
              {counts.map((c) => (
                <li key={c.hop}>
                  <span
                    class={`hop-badge__dot hop-badge__dot--${
                      Math.min(c.hop, 3)
                    }`}
                  />
                  <span class="hop-list__label">
                    {c.hop === 0
                      ? "You"
                      : c.hop === 1
                      ? "People you follow"
                      : `${c.hop} hops away`}
                  </span>
                  <strong>{formatCount(c.count)}</strong>
                </li>
              ))}
            </ul>
            <dl class="figures">
              <div>
                <dt>Events</dt>
                <dd>{formatCount(s.stats.events)}</dd>
              </div>
              <div>
                <dt>Triples</dt>
                <dd>{formatCount(s.stats.triples)}</dd>
              </div>
              <div>
                <dt>Authors</dt>
                <dd>{formatCount(s.stats.authors)}</dd>
              </div>
            </dl>
            <p class="muted">
              Replicating {s.hops} {s.hops === 1 ? "hop" : "hops"} out.{" "}
              <Link to="/settings">Change the depth in Settings</Link>.
            </p>
          </div>
        </div>
      </section>

      <section class="card net-section" aria-labelledby="net-replication">
        <div class="net-section__head">
          <h2 id="net-replication" class="net-section__title">Replication</h2>
          <span
            class={`net-pill net-pill--${s.replication.enabled ? "on" : "off"}`}
          >
            {s.replication.enabled ? "On" : "Off"}
          </span>
        </div>
        <p class="muted" aria-live="polite">{replicationSummary(s)}</p>
        {!s.replication.enabled && (
          <p class="net-empty">
            Replication is off, so the node fetches nothing from other relays.
            It keeps what is published to it directly. Turn it on in{" "}
            <Link to="/settings">Settings</Link>.
          </p>
        )}
        {s.replication.enabled && relays.length === 0 && (
          <p class="net-empty">
            No relays are in use yet. They appear as the node finds the people
            in its network and where they publish.
          </p>
        )}
        {relays.length > 0 && <RelayTable relays={relays} />}
      </section>

      <section class="card net-section" aria-labelledby="net-connect">
        <h2 id="net-connect" class="net-section__title">Connect</h2>
        <CopyField
          label="Relay"
          value={s.relayUrl}
          hint="Add it to a Nostr client as a relay. Only people in the network may publish here."
        />
        {s.blossom.enabled && (
          <CopyField
            label="Blossom media server"
            value={origin}
            hint="Clients upload media here. Uploaders must be in the network."
          />
        )}
        <CopyField
          label="SPARQL endpoint"
          value={`${origin}/sparql`}
          hint={s.publicSparql
            ? "Query the graph with SPARQL 1.1. Anybody may read it."
            : "Query the graph with SPARQL 1.1. Only the owner may read it, so requests need a signature."}
        />
      </section>

      <section class="card net-section" aria-labelledby="net-explore">
        <h2 id="net-explore" class="net-section__title">Explore the graph</h2>
        <p class="muted">
          Everything the node holds is one RDF graph. These queries run against
          it as they are written; the prefixes are filled in for you.
        </p>
        <SparqlConsole />
      </section>
    </div>
  );
}
