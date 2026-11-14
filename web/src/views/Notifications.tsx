/**
 * Placeholder for the Notifications view; to be replaced by the real view.
 *
 * @module
 */
import { Bell } from "lucide-preact";
import { EmptyState } from "../components/EmptyState.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { useDocumentTitle } from "../lib/hooks.ts";
import { useRoute } from "../lib/router.tsx";

/** The Notifications view. */
export default function NotificationsView() {
  const { params } = useRoute();
  useDocumentTitle("Notifications");
  return (
    <div class="page">
      <PageHeader title="Notifications" />
      <EmptyState title="Notifications view" icon={<Bell size={36} />}>
        Replies, mentions and reactions. This view is not built yet.
        {Object.keys(params).length > 0 && (
          <span class="mono">{JSON.stringify(params)}</span>
        )}
      </EmptyState>
    </div>
  );
}
