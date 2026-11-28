/**
 * A note in a list: {@link NoteCard} with its counts from the shared note
 * state, reply / repost / like wired to the actions, "Reposted by …" above
 * reposts, and a delete button (with confirmation) on the viewer's own notes.
 *
 * @module
 */
import type { ComponentChildren } from "preact";
import { Repeat2, Trash2 } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  deleteNote,
  hiddenNotes,
  toggleLike,
  toggleRepost,
  unrepost,
  useNoteStats,
} from "../lib/actions.ts";
import { type NoteRow, toEvent } from "../lib/feed.ts";
import { session } from "../lib/session.ts";
import { speakingKey } from "../lib/speech.ts";
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
  const root = useRef<HTMLDivElement>(null);
  const speaking = speakingKey.value === note.key;
  useEffect(() => {
    // Follow the reading: bring the note being read into view.
    if (speaking) {
      root.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [speaking]);
  if (hiddenNotes.value.has(note.id)) return null;
  if (note.repostedBy && hiddenNotes.value.has(note.repostedBy.id)) return null;
  const event = toEvent(note);
  const me = session.value?.pubkey;
  // A repost card offers to take back the viewer's own repost, never the
  // original; the original's delete button is only on the viewer's own notes.
  const myRepost = note.repostedBy?.pubkey === me ? note.repostedBy : undefined;
  const ownNote = !note.repostedBy && me === note.pubkey;
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
    <div
      ref={root}
      class={`note-item note-item--${variant}${
        speaking ? " note-item--speaking" : ""
      }`}
      data-note-key={note.key}
      data-note-at={note.at}
      aria-current={speaking ? "true" : undefined}
    >
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
      {(myRepost || ownNote) && (
        <div class="note-item__delete">
          <IconButton
            label={myRepost ? "Remove repost" : "Delete note"}
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
        title={myRepost ? "Remove your repost?" : "Delete this note?"}
        size="sm"
      >
        <p class="muted">
          {myRepost
            ? "Your repost is taken back. The note itself stays where it is."
            : "This asks every relay that has the note to remove it. Copies that other people already saved may remain."}
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
              if (myRepost) await unrepost(myRepost.id, note.id);
              else await deleteNote(event);
              setDeleting(false);
              setConfirming(false);
            }}
          >
            {myRepost ? "Remove repost" : "Delete"}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
