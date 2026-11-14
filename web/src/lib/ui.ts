/**
 * Global UI state that any view may trigger: the compose dialog and the
 * login dialog.
 *
 * @module
 */
import { signal } from "@preact/signals";
import type { NoteEvent } from "./nostr.ts";

/** State of the global compose dialog; `null` when closed. */
export const composeState = signal<{ replyTo?: NoteEvent } | null>(null);
/** Whether the login dialog is open. */
export const loginOpen = signal(false);

/** Open the compose dialog, optionally as a reply to `replyTo`. */
export function openCompose(replyTo?: NoteEvent): void {
  composeState.value = { replyTo };
}

/** Close the compose dialog. */
export function closeCompose(): void {
  composeState.value = null;
}

/** Open the login dialog. */
export function openLogin(): void {
  loginOpen.value = true;
}
