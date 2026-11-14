/**
 * Placeholder for the Reads view; to be replaced by the real view.
 *
 * @module
 */
import { BookOpen } from "lucide-preact";
import { EmptyState } from "../components/EmptyState.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { useDocumentTitle } from "../lib/hooks.ts";
import { useRoute } from "../lib/router.tsx";

/** The Reads view. */
export default function ReadsView() {
  const { params } = useRoute();
  useDocumentTitle("Reads");
  return (
    <div class="page">
      <PageHeader title="Reads" />
      <EmptyState title="Reads view" icon={<BookOpen size={36} />}>
        Long-form articles from your neighbourhood. This view is not built yet.
        {Object.keys(params).length > 0 && (
          <span class="mono">{JSON.stringify(params)}</span>
        )}
      </EmptyState>
    </div>
  );
}
