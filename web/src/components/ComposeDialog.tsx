/**
 * The global compose dialog, opened with `openCompose()` from `lib/ui.ts`.
 * Rendered once by the Shell.
 *
 * @module
 */
import { submitNote } from "../lib/actions.ts";
import { closeCompose, composeState } from "../lib/ui.ts";
import { AuthorName } from "./AuthorName.tsx";
import { Composer } from "./Composer.tsx";
import { Modal } from "./Modal.tsx";
import { toast } from "./Toast.tsx";

/** Modal with a {@link Composer} that publishes a note or reply. */
export function ComposeDialog() {
  const state = composeState.value;
  const parent = state?.replyTo;
  return (
    <Modal
      open={state !== null}
      onClose={closeCompose}
      title={parent ? "Reply" : "New note"}
    >
      {parent && (
        <p class="compose-dialog__parent muted">
          Replying to <AuthorName pubkey={parent.pubkey} showNip05={false} />
          <span class="compose-dialog__quote">
            {parent.content.slice(0, 140)}
          </span>
        </p>
      )}
      <Composer
        autoFocus
        placeholder={parent ? "Write your reply" : "What is on your mind?"}
        submitLabel={parent ? "Reply" : "Post"}
        onCancel={closeCompose}
        onSubmit={async (content) => {
          await submitNote(content, parent);
          closeCompose();
          toast(parent ? "Reply sent" : "Note published", "success");
        }}
      />
    </Modal>
  );
}
