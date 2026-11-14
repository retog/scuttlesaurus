/**
 * Placeholder for the Note view; to be replaced by the real view.
 *
 * @module
 */
import { MessageSquare } from "lucide-preact";
import { EmptyState } from "../components/EmptyState.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { useDocumentTitle } from "../lib/hooks.ts";
import { useRoute } from "../lib/router.tsx";

/** The Note view. */
export default function NoteView() {
  const { params } = useRoute();
  useDocumentTitle("Note");
  return (
    <div class="page">
      <PageHeader title="Note" />
      <EmptyState title="Note view" icon={<MessageSquare size={36} />}>
        A note with its thread. This view is not built yet.
        {Object.keys(params).length > 0 && (
          <span class="mono">{JSON.stringify(params)}</span>
        )}
      </EmptyState>
    </div>
  );
}
