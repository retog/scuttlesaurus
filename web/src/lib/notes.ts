/**
 * Publishing notes: builds the tags and sends a kind 1 event.
 *
 * @module
 */
import type { Event } from "@nostr/tools/core";
import { publish } from "./session.ts";
import { contentTags, type NoteEvent, replyTags } from "./nostr.ts";

/**
 * Publish a kind 1 note, as a reply when `parent` is given. Adds `p`/`q`/`t`
 * tags for mentions, quotes and hashtags in the text. Resolves with the signed
 * event; rejects with the relay's reason when it refuses.
 */
export function postNote(content: string, parent?: NoteEvent): Promise<Event> {
  const base = parent ? replyTags(parent) : [];
  return publish({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    content,
    tags: [...base, ...contentTags(content, base)],
  });
}
