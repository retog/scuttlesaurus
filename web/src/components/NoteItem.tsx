/**
 * A note in a list: {@link NoteCard} with its counts from the shared note
 * state, reply / repost / like wired to the actions, "Reposted by …" above
 * reposts, and a delete button (with confirmation) on the viewer's own notes.
 *
 * @module
 */
import type { ComponentChildren } from "preact";
import { Repeat2, Trash2 } from "lucide-preact";
import { useState } from "preact/hooks";
import {
  deleteNote,
  hiddenNotes,
  toggleLike,
  toggleRepost,
  useNoteStats,
} from "../lib/actions.ts";
import { type NoteRow, toEvent } from "../lib/feed.ts";
import { session } from "../lib/session.ts";
import { openCompose } from "../lib/ui.ts";
import { AuthorName } from "./AuthorName.tsx";
import { Button, IconButton } from "./Button.tsx";
import { Modal } from "./Modal.tsx";
import { NoteCard } from "./NoteCard.tsx";

/** Props of {@link NoteItem}. */
export interface NoteItemProps {
  note: NoteRow;
  /** `focused` is the subject of a thread view (default `default`). */
  variant?: "default" | "focused";
  /** Line above the note; reposts get "Reposted by …" instead. */
  context?: ComponentChildren;
}

/** A note with counts and working actions. */
export function NoteItem(
  { note, variant = "default", context }: NoteItemProps,
) {
  const stats = useNoteStats(note.id);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  if (hiddenNotes.value.has(note.id)) return null;
  const event = toEvent(note);
  const own = session.value?.pubkey === note.pubkey;
  const count = (n: number) => stats.loaded ? n : undefined;
  const line = note.repostedBy
    ? (
      <span class="note-item__repost">
        <Repeat2 size={14} aria-hidden="true" /> Reposted by{" "}
        <AuthorName
          pubkey={note.repostedBy.pubkey}
          showNip05={false}
          showHops={false}
        />
      </span>
    )
    : context;
  return (
    <div class={`note-item note-item--${variant}`}>
      <NoteCard
        note={event}
        variant={variant}
        context={line}
        replyCount={count(stats.replies)}
        repostCount={count(stats.reposts)}
        likeCount={count(stats.likes)}
        liked={Boolean(stats.myLike)}
        reposted={Boolean(stats.myRepost)}
        onReply={() => openCompose(event)}
        onRepost={() => void toggleRepost(event)}
        onLike={() => void toggleLike(event)}
      />
      {own && (
        <div class="note-item__delete">
          <IconButton
            label="Delete note"
            size="sm"
            variant="danger"
            icon={<Trash2 size={16} />}
            onClick={() => setConfirming(true)}
          />
        </div>
      )}
      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Delete this note?"
        size="sm"
      >
        <p class="muted">
          This asks every relay that has the note to remove it. Copies that
          other people already saved may remain.
        </p>
        <div class="note-item__confirm">
          <Button variant="ghost" onClick={() => setConfirming(false)}>
            Keep it
          </Button>
          <Button
            variant="danger"
            loading={deleting}
            onClick={async () => {
              setDeleting(true);
              await deleteNote(event);
              setDeleting(false);
              setConfirming(false);
            }}
          >
            Delete
          </Button>
        </div>
      </Modal>
    </div>
  );
}
