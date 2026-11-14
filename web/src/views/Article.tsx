/**
 * Placeholder for the Article view; to be replaced by the real view.
 *
 * @module
 */
import { BookText } from "lucide-preact";
import { EmptyState } from "../components/EmptyState.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { useDocumentTitle } from "../lib/hooks.ts";
import { useRoute } from "../lib/router.tsx";

/** The Article view. */
export default function ArticleView() {
  const { params } = useRoute();
  useDocumentTitle("Article");
  return (
    <div class="page">
      <PageHeader title="Article" />
      <EmptyState title="Article view" icon={<BookText size={36} />}>
        An article, with comments. This view is not built yet.
        {Object.keys(params).length > 0 && (
          <span class="mono">{JSON.stringify(params)}</span>
        )}
      </EmptyState>
    </div>
  );
}
