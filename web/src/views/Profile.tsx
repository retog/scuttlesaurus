/**
 * Placeholder for the Profile view; to be replaced by the real view.
 *
 * @module
 */
import { User } from "lucide-preact";
import { EmptyState } from "../components/EmptyState.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { useDocumentTitle } from "../lib/hooks.ts";
import { useRoute } from "../lib/router.tsx";

/** The Profile view. */
export default function ProfileView() {
  const { params } = useRoute();
  useDocumentTitle("Profile");
  return (
    <div class="page">
      <PageHeader title="Profile" />
      <EmptyState title="Profile view" icon={<User size={36} />}>
        Notes, articles and follows of one person. This view is not built yet.
        {Object.keys(params).length > 0 && (
          <span class="mono">{JSON.stringify(params)}</span>
        )}
      </EmptyState>
    </div>
  );
}
