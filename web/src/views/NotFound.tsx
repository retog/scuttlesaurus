/**
 * Shown for paths that match no route.
 *
 * @module
 */
import { Compass } from "lucide-preact";
import { Button } from "../components/Button.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { useDocumentTitle } from "../lib/hooks.ts";

/** The not-found view. */
export default function NotFoundView() {
  useDocumentTitle("Not found");
  return (
    <div class="page">
      <EmptyState
        title="Nothing lives here"
        icon={<Compass size={36} />}
        action={<Button to="/" variant="primary">Back home</Button>}
      >
        This address does not match any page of the client.
      </EmptyState>
    </div>
  );
}
