/**
 * Placeholder for the Home view; to be replaced by the real view.
 *
 * @module
 */
import { House } from "lucide-preact";
import { EmptyState } from "../components/EmptyState.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { useDocumentTitle } from "../lib/hooks.ts";
import { useRoute } from "../lib/router.tsx";

/** The Home view. */
export default function HomeView() {
  const { params } = useRoute();
  useDocumentTitle("Home");
  return (
    <div class="page">
      <PageHeader title="Home" />
      <EmptyState title="Home view" icon={<House size={36} />}>
        Notes from the people near you will appear here. This view is not built
        yet.
        {Object.keys(params).length > 0 && (
          <span class="mono">{JSON.stringify(params)}</span>
        )}
      </EmptyState>
    </div>
  );
}
