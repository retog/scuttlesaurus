/**
 * Placeholder for the Network view; to be replaced by the real view.
 *
 * @module
 */
import { Network } from "lucide-preact";
import { EmptyState } from "../components/EmptyState.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { useDocumentTitle } from "../lib/hooks.ts";
import { useRoute } from "../lib/router.tsx";

/** The Network view. */
export default function NetworkView() {
  const { params } = useRoute();
  useDocumentTitle("Network");
  return (
    <div class="page">
      <PageHeader title="Network" />
      <EmptyState title="Network view" icon={<Network size={36} />}>
        The node: social graph, relays, replication, SPARQL console. This view
        is not built yet.
        {Object.keys(params).length > 0 && (
          <span class="mono">{JSON.stringify(params)}</span>
        )}
      </EmptyState>
    </div>
  );
}
