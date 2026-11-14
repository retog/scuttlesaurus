/**
 * Placeholder for the Write view; to be replaced by the real view.
 *
 * @module
 */
import { PenLine } from "lucide-preact";
import { EmptyState } from "../components/EmptyState.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { useDocumentTitle } from "../lib/hooks.ts";
import { useRoute } from "../lib/router.tsx";

/** The Write view. */
export default function WriteView() {
  const { params } = useRoute();
  useDocumentTitle("Write");
  return (
    <div class="page">
      <PageHeader title="Write" />
      <EmptyState title="Write view" icon={<PenLine size={36} />}>
        The article editor. This view is not built yet.
        {Object.keys(params).length > 0 && (
          <span class="mono">{JSON.stringify(params)}</span>
        )}
      </EmptyState>
    </div>
  );
}
