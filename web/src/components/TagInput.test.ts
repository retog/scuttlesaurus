import { assertEquals } from "@std/assert";
import { addTopics } from "./TagInput.tsx";

Deno.test("pasted topics separated by commas or lines are added one by one", () => {
  assertEquals(addTopics(["nostr"], "foo,bar\nbaz", 8), [
    "nostr",
    "foo",
    "bar",
    "baz",
  ]);
});

Deno.test("duplicates and empty parts are skipped and the maximum holds", () => {
  assertEquals(addTopics(["foo"], "foo,, bar ,baz", 2), ["foo", "bar"]);
});
