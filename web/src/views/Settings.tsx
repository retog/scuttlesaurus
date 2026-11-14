/**
 * Placeholder for the Settings view; to be replaced by the real view.
 *
 * @module
 */
import { Settings } from "lucide-preact";
import { EmptyState } from "../components/EmptyState.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { useDocumentTitle } from "../lib/hooks.ts";
import { useRoute } from "../lib/router.tsx";

/** The Settings view. */
export default function SettingsView() {
  const { params } = useRoute();
  useDocumentTitle("Settings");
  return (
    <div class="page">
      <PageHeader title="Settings" />
      <EmptyState title="Settings view" icon={<Settings size={36} />}>
        Owner settings. This view is not built yet.
        {Object.keys(params).length > 0 && (
          <span class="mono">{JSON.stringify(params)}</span>
        )}
      </EmptyState>
    </div>
  );
}
