/**
 * Placeholder for the Search view; to be replaced by the real view.
 *
 * @module
 */
import { Search } from "lucide-preact";
import { EmptyState } from "../components/EmptyState.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { useDocumentTitle } from "../lib/hooks.ts";
import { useRoute } from "../lib/router.tsx";

/** The Search view. */
export default function SearchView() {
  const { params } = useRoute();
  useDocumentTitle("Search");
  return (
    <div class="page">
      <PageHeader title="Search" />
      <EmptyState title="Search view" icon={<Search size={36} />}>
        People, notes and articles. This view is not built yet.
        {Object.keys(params).length > 0 && (
          <span class="mono">{JSON.stringify(params)}</span>
        )}
      </EmptyState>
    </div>
  );
}
