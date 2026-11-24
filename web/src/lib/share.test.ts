/// <reference lib="deno.ns" />
/**
 * The note text made from a share, and the Nostr reference found in it.
 *
 * @module
 */
import { assertEquals } from "@std/assert";
import * as nip19 from "@nostr/tools/nip19";
import {
  composeShared,
  sharedFromQuery,
  sharedLink,
  sharedNostrPath,
} from "./share.ts";

Deno.test("a shared page becomes its title and link", () => {
  assertEquals(
    composeShared({ title: "A page", url: "https://example.org/a" }),
    "A page\n\nhttps://example.org/a",
  );
});

Deno.test("a link in the text is not repeated", () => {
  const shared = {
    title: "A page",
    text: "Look at this https://example.org/a",
    url: "https://example.org/a",
  };
  assertEquals(
    composeShared(shared),
    "A page\n\nLook at this https://example.org/a",
  );
});

Deno.test("a link only in the text, as Android apps share it", () => {
  const shared = { title: "A page", text: "https://example.org/a" };
  assertEquals(sharedLink(shared), "https://example.org/a");
  assertEquals(composeShared(shared), "A page\n\nhttps://example.org/a");
});

Deno.test("only web addresses become the link of a share", () => {
  assertEquals(sharedLink({ url: "javascript:alert(1)" }), undefined);
  assertEquals(sharedLink({ url: "data:text/html,<b>x</b>" }), undefined);
  assertEquals(
    sharedLink({ url: "javascript:alert(1)", text: "see https://x.org/a" }),
    "https://x.org/a",
  );
  assertEquals(sharedLink({ url: "HTTPS://x.org/" }), "HTTPS://x.org/");
});

Deno.test("a title that is the link or part of the text is dropped", () => {
  assertEquals(
    composeShared({ title: "https://x.org", url: "https://x.org" }),
    "https://x.org",
  );
  assertEquals(
    composeShared({ title: "Hello", text: "Hello world" }),
    "Hello world",
  );
});

Deno.test("empty and blank query fields are absent", () => {
  const shared = sharedFromQuery(
    new URLSearchParams("title=%20&text=hi&url="),
  );
  assertEquals(shared, { title: undefined, text: "hi", url: undefined });
  assertEquals(composeShared({}), "");
});

Deno.test("a Nostr reference in a shared link opens in the app", () => {
  const id = "a".repeat(64);
  const note = nip19.noteEncode(id);
  assertEquals(
    sharedNostrPath({ url: `https://njump.me/${note}` }),
    `/n/${note}`,
  );
  assertEquals(
    sharedNostrPath({ text: `nostr:${note}` }),
    `/n/${note}`,
  );
  assertEquals(sharedNostrPath({ url: "https://example.org/" }), undefined);
});
