/**
 * What a person can do with a note: like, repost, delete, post. Every action
 * updates the shared per-note state ({@link useNoteStats}, {@link hiddenNotes})
 * immediately and rolls it back with a toast when the relay refuses.
 *
 * @module
 */
import { computed, type Signal, signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { toast } from "../components/Toast.tsx";
import { fetchCounts, type NoteCounts } from "./feed.ts";
import { ownerPubkey } from "./node.ts";
import type { NoteEvent } from "./nostr.ts";
import { postNote } from "./notes.ts";
import { type Event, fetchEvents } from "./relay.ts";
import { canSign, publish, session } from "./session.ts";
import { openLogin } from "./ui.ts";

/** Counts of a note plus whether they have been loaded yet. */
export interface NoteStats extends NoteCounts {
  loaded: boolean;
}

/**
 * Whose point of view the feeds take: the signed-in person, else the node's
 * owner, else `null` (a node that has no owner yet).
 */
export const viewerKey = computed<string | null>(() =>
  session.value?.pubkey ?? ownerPubkey.value ?? null
);

/** Ids of notes the viewer has deleted in this page view (hidden at once). */
export const hiddenNotes = signal<ReadonlySet<string>>(new Set());

const PENDING = "pending";
const stats = new Map<string, Signal<NoteStats>>();
const inFlight = new Set<string>();

function slot(id: string): Signal<NoteStats> {
  let s = stats.get(id);
  if (!s) {
    s = signal({ replies: 0, likes: 0, reposts: 0, loaded: false });
    stats.set(id, s);
  }
  return s;
}

/** The shared counts of a note; reading it in a component subscribes to it. */
export function useNoteStats(id: string): NoteStats {
  return slot(id).value;
}

/**
 * Load the counts of `ids` (one query) into the shared state, together with
 * the signed-in person's own reactions and reposts. Notes whose own action is
 * in flight keep their optimistic state. Errors are swallowed: the counts
 * just stay empty.
 */
export async function loadStats(ids: readonly string[]): Promise<void> {
  const wanted = ids.filter((id) => !inFlight.has(id));
  if (wanted.length === 0) return;
  try {
    const counts = await fetchCounts(wanted, session.value?.pubkey);
    for (const [id, c] of counts) {
      if (inFlight.has(id)) continue;
      slot(id).value = { ...c, loaded: true };
    }
  } catch {
    // counts are decoration; the note itself is already on screen
  }
}

/** Load the counts of `ids` whenever they change (for views with their own lists). */
export function useLoadStats(ids: readonly string[]): void {
  const key = ids.join(",");
  useEffect(() => {
    void loadStats(ids);
  }, [key, session.value?.pubkey]);
}

/** Plain-words version of a relay refusal or network failure. */
export function explainRefusal(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/^blocked:/i.test(message)) {
    return "This node only takes notes from people inside its social graph, " +
      "and you are outside it. Ask its owner to follow you, or use a node " +
      "you belong to.";
  }
  return message.replace(
    /^(invalid|restricted|rate-limited|error|pow|duplicate):\s*/i,
    "",
  ) || "The relay refused the event";
}

/**
 * Publish a note or reply like `postNote` does, but reject with a message in
 * plain words. This is what the composers of the views call.
 */
export async function submitNote(
  content: string,
  parent?: NoteEvent,
): Promise<Event> {
  try {
    return await postNote(content, parent);
  } catch (error) {
    throw new Error(explainRefusal(error));
  }
}

function signedIn(): boolean {
  if (canSign.value) return true;
  toast(
    session.value
      ? "You are browsing read-only. Sign in with a key to do this."
      : "Sign in to do this.",
    "info",
  );
  openLogin();
  return false;
}

const now = () => Math.floor(Date.now() / 1000);

function setHidden(id: string, hidden: boolean): void {
  const next = new Set(hiddenNotes.peek());
  if (hidden) next.add(id);
  else next.delete(id);
  hiddenNotes.value = next;
}

function update(id: string, change: (s: NoteStats) => NoteStats): void {
  const s = slot(id);
  s.value = change(s.peek());
}

/** Like a note (NIP-25: kind 7, `+`). Does nothing when already liked. */
export async function likeNote(note: NoteEvent): Promise<void> {
  if (!signedIn()) return;
  const current = slot(note.id).peek();
  if (current.myLike || inFlight.has(note.id)) return;
  inFlight.add(note.id);
  update(note.id, (s) => ({ ...s, likes: s.likes + 1, myLike: PENDING }));
  try {
    const event = await publish({
      kind: 7,
      created_at: now(),
      content: "+",
      tags: [["e", note.id], ["p", note.pubkey], ["k", "1"]],
    });
    update(note.id, (s) => ({ ...s, myLike: event.id }));
  } catch (error) {
    update(
      note.id,
      (s) => ({ ...s, likes: Math.max(0, s.likes - 1), myLike: undefined }),
    );
    toast(explainRefusal(error), "error");
  } finally {
    inFlight.delete(note.id);
  }
}

/** Take back a like: a deletion request (NIP-09) for the reaction `reactionId`. */
export async function unlike(
  reactionId: string,
  noteId: string,
): Promise<void> {
  if (!signedIn() || reactionId === PENDING || inFlight.has(noteId)) return;
  inFlight.add(noteId);
  update(noteId, (s) => ({
    ...s,
    likes: Math.max(0, s.likes - 1),
    myLike: undefined,
  }));
  try {
    await publish({
      kind: 5,
      created_at: now(),
      content: "",
      tags: [["e", reactionId], ["k", "7"]],
    });
  } catch (error) {
    update(
      noteId,
      (s) => ({ ...s, likes: s.likes + 1, myLike: reactionId }),
    );
    toast(explainRefusal(error), "error");
  } finally {
    inFlight.delete(noteId);
  }
}

/** Like the note, or take the like back when there is one. */
export function toggleLike(note: NoteEvent): Promise<void> {
  const mine = slot(note.id).peek().myLike;
  return mine ? unlike(mine, note.id) : likeNote(note);
}

/**
 * Repost a note (NIP-18: kind 6 whose content is the original event as JSON).
 * Does nothing when already reposted.
 */
export async function repostNote(note: NoteEvent): Promise<void> {
  if (!signedIn()) return;
  const current = slot(note.id).peek();
  if (current.myRepost || inFlight.has(note.id)) return;
  inFlight.add(note.id);
  update(note.id, (s) => ({ ...s, reposts: s.reposts + 1, myRepost: PENDING }));
  try {
    const [original] = await fetchEvents([{ ids: [note.id] }]);
    if (!original) throw new Error("This node no longer has that note");
    const event = await publish({
      kind: 6,
      created_at: now(),
      content: JSON.stringify(original),
      tags: [["e", note.id], ["p", note.pubkey]],
    });
    update(note.id, (s) => ({ ...s, myRepost: event.id }));
  } catch (error) {
    update(
      note.id,
      (s) => ({
        ...s,
        reposts: Math.max(0, s.reposts - 1),
        myRepost: undefined,
      }),
    );
    toast(explainRefusal(error), "error");
  } finally {
    inFlight.delete(note.id);
  }
}

/**
 * Undo a repost with a deletion request (NIP-09) for the kind 6 event. The
 * repost also disappears from a feed that shows it ({@link hiddenNotes}).
 */
export async function unrepost(
  repostId: string,
  noteId: string,
): Promise<void> {
  if (!signedIn() || repostId === PENDING || inFlight.has(noteId)) return;
  inFlight.add(noteId);
  update(noteId, (s) => ({
    ...s,
    reposts: Math.max(0, s.reposts - 1),
    myRepost: undefined,
  }));
  setHidden(repostId, true);
  try {
    await publish({
      kind: 5,
      created_at: now(),
      content: "",
      tags: [["e", repostId], ["k", "6"]],
    });
  } catch (error) {
    update(
      noteId,
      (s) => ({ ...s, reposts: s.reposts + 1, myRepost: repostId }),
    );
    setHidden(repostId, false);
    toast(explainRefusal(error), "error");
  } finally {
    inFlight.delete(noteId);
  }
}

/** Repost the note, or undo the repost when there is one. */
export function toggleRepost(note: NoteEvent): Promise<void> {
  const mine = slot(note.id).peek().myRepost;
  return mine ? unrepost(mine, note.id) : repostNote(note);
}

/**
 * Delete one of the viewer's own notes (NIP-09: kind 5 with `e` and `k`
 * tags). The note disappears at once ({@link hiddenNotes}) and comes back
 * with a toast if the relay refuses. Returns whether it was deleted.
 */
export async function deleteNote(note: NoteEvent): Promise<boolean> {
  if (!signedIn()) return false;
  if (session.value?.pubkey !== note.pubkey) {
    toast("You can only delete your own notes.", "error");
    return false;
  }
  setHidden(note.id, true);
  try {
    await publish({
      kind: 5,
      created_at: now(),
      content: "",
      tags: [["e", note.id], ["k", String(note.kind ?? 1)]],
    });
    return true;
  } catch (error) {
    setHidden(note.id, false);
    toast(explainRefusal(error), "error");
    return false;
  }
}
