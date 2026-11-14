/**
 * Wire-level rules of the relay: the limits advertised in NIP-11, parsing of
 * client frames (NIP-01) and validation of subscription ids, filters and
 * events. Everything here is a pure function; the connection logic lives in
 * `connection.ts`.
 * @module
 */
import type { Filter } from "@nostr/tools/filter";
import { validateEvent, verifyEvent } from "@nostr/tools/pure";
import type { NostrEvent } from "../types.ts";

/** Largest accepted text frame, in bytes (NIP-11 `max_message_length`). */
export const MAX_MESSAGE_BYTES = 128 * 1024;
/** Open subscriptions per connection (NIP-11 `max_subscriptions`). */
export const MAX_SUBSCRIPTIONS = 20;
/** Filters per REQ or COUNT (NIP-11 `max_filters`). */
export const MAX_FILTERS = 10;
/** Longest subscription id (NIP-11 `max_subid_length`). */
export const MAX_SUBID_LENGTH = 64;
/** Bytes queued on a socket beyond which the client is dropped as too slow. */
export const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/** Kind of the NIP-46 (Nostr Connect) request and response events. */
export const NOSTR_CONNECT_KIND = 24133;
/** Largest accepted Nostr Connect event, serialized, in bytes. */
export const MAX_NOSTR_CONNECT_BYTES = 64 * 1024;

const MACHINE_PREFIXES = [
  "duplicate:",
  "blocked:",
  "invalid:",
  "error:",
  "rate-limited:",
];

/** Result of reading one client frame. */
export type FrameResult =
  | { ok: true; parts: unknown[] }
  | { ok: false; notice: string };

/**
 * Parses a client frame into its JSON array. Only text frames of at most
 * {@link MAX_MESSAGE_BYTES} bytes holding a JSON array are accepted (NIP-01).
 */
export function parseFrame(data: unknown): FrameResult {
  if (typeof data !== "string") {
    return fail("only text frames are supported");
  }
  if (
    data.length > MAX_MESSAGE_BYTES ||
    new TextEncoder().encode(data).byteLength > MAX_MESSAGE_BYTES
  ) {
    return fail("message is larger than 128 KiB");
  }
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return fail("message is not valid JSON");
  }
  if (!Array.isArray(value)) {
    return fail("message must be a JSON array");
  }
  return { ok: true, parts: value };
}

function fail(notice: string): FrameResult {
  return { ok: false, notice };
}

/** Whether a value is a JSON object (not an array, not null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a value can be used as a subscription id (NIP-01). */
export function isSubscriptionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MAX_SUBID_LENGTH;
}

/** Whether a value is a lowercase 64-character hex event id. */
export function isEventId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * The id of an event-shaped value if it is usable, else undefined. Used to
 * decide whether a rejected EVENT can be answered with `OK`.
 */
export function eventIdOf(value: unknown): string | undefined {
  return isRecord(value) && isEventId(value.id) ? value.id : undefined;
}

/**
 * Parses the filters of a REQ or COUNT message. Returns the error text (without
 * any machine prefix) when there are none, too many, or one is not an object.
 */
export function parseFilters(
  values: unknown[],
): { filters: Filter[] } | { error: string } {
  if (values.length === 0) {
    return { error: "at least one filter is required" };
  }
  if (values.length > MAX_FILTERS) {
    return { error: `at most ${MAX_FILTERS} filters are allowed` };
  }
  const filters: Filter[] = [];
  for (const value of values) {
    if (!isRecord(value)) {
      return { error: "each filter must be a JSON object" };
    }
    filters.push(value as Filter);
  }
  return { filters };
}

/**
 * Returns the filter with its `limit` lowered to `maxLimit` when it asks for
 * more. A filter without a limit is returned unchanged; the store applies its
 * default.
 */
export function clampLimit(filter: Filter, maxLimit: number): Filter {
  return typeof filter.limit === "number" && filter.limit > maxLimit
    ? { ...filter, limit: maxLimit }
    : filter;
}

/**
 * Prefixes a rejection reason with `invalid: ` unless it already starts with
 * one of the machine-readable prefixes of NIP-01 (`duplicate:`, `blocked:`,
 * `invalid:`, `error:`, `rate-limited:`).
 */
export function withMachinePrefix(reason: string): string {
  return MACHINE_PREFIXES.some((prefix) => reason.startsWith(prefix))
    ? reason
    : `invalid: ${reason}`;
}

/**
 * Checks that a value is a well-formed event with a valid signature (NIP-01,
 * `validateEvent` and `verifyEvent`). The error text is for the client.
 */
export function parseSignedEvent(
  value: unknown,
): { event: NostrEvent } | { error: string } {
  if (!isRecord(value) || !validateEvent(value)) {
    return { error: "malformed event" };
  }
  if (typeof value.id !== "string" || typeof value.sig !== "string") {
    return { error: "malformed event" };
  }
  const event = value as NostrEvent;
  let valid: boolean;
  try {
    valid = verifyEvent(event);
  } catch {
    valid = false;
  }
  return valid ? { event } : { error: "id or signature does not verify" };
}

/**
 * Why `event` cannot be relayed as a NIP-46 Nostr Connect message from an
 * arbitrary author, or `undefined` when it can: it must be of kind 24133,
 * carry at least one `p` tag with a valid hex pubkey (the recipient) and be at
 * most {@link MAX_NOSTR_CONNECT_BYTES} serialized. The text is for the client.
 * Signature and shape are checked elsewhere ({@link parseSignedEvent}).
 */
export function nostrConnectProblem(event: NostrEvent): string | undefined {
  if (event.kind !== NOSTR_CONNECT_KIND) return "not a Nostr Connect event";
  const addressed = event.tags.some((tag) =>
    tag[0] === "p" && typeof tag[1] === "string" &&
    /^[0-9a-f]{64}$/.test(tag[1])
  );
  if (!addressed) {
    return "a Nostr Connect event needs a p tag with the recipient's pubkey";
  }
  if (
    new TextEncoder().encode(JSON.stringify(event)).byteLength >
      MAX_NOSTR_CONNECT_BYTES
  ) {
    return "a Nostr Connect event must be at most 64 KiB";
  }
  return undefined;
}

/** The message of an unknown thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
