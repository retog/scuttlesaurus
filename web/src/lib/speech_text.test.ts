/// <reference lib="deno.ns" />
/**
 * The text the read-aloud player speaks: notes and Markdown become plain
 * sentences, and long text is cut into short chunks.
 *
 * @module
 */
import { assert, assertEquals } from "@std/assert";
import {
  chunkText,
  markdownSpeechText,
  noteSpeechText,
} from "./speech_text.ts";
import { toNpub } from "./nostr.ts";

const ALICE = "a".repeat(64);
const nameOf = (pubkey: string) => pubkey === ALICE ? "Alice" : "someone";

Deno.test("a note says names, links and media instead of raw strings", () => {
  const content = `Hello nostr:${toNpub(ALICE)}! See https://www.example.com/x
https://example.com/cat.png #deno`;
  assertEquals(
    noteSpeechText(content, nameOf),
    "Hello Alice! See (link to example.com)\n(image) hashtag deno",
  );
});

Deno.test("Markdown loses its markup, headings and list items get a stop", () => {
  const md = `# A title

Some **bold** and _italic_ text with [a link](https://example.com).

- first
- second!

\`\`\`ts
const x = 1;
\`\`\`

> quoted &amp; kept

![a cat](https://example.com/cat.png)`;
  assertEquals(markdownSpeechText(md, nameOf), [
    "A title.",
    "Some bold and italic text with a link.",
    "first.",
    "second!",
    "(code example)",
    "quoted & kept",
    "(image: a cat)",
  ]);
});

Deno.test("short sentences are joined, long ones are split", () => {
  assertEquals(chunkText("One. Two. Three.", 20), ["One. Two. Three."]);
  assertEquals(chunkText("One sentence. Another sentence.", 20), [
    "One sentence.",
    "Another sentence.",
  ]);
  const long = "word ".repeat(100).trim() + ".";
  const chunks = chunkText(long, 50);
  assert(chunks.length > 1);
  for (const chunk of chunks) assert(chunk.length <= 50, chunk);
  assertEquals(chunks.join(" "), long);
});

Deno.test("clauses are tried before words, line breaks end a chunk", () => {
  assertEquals(
    chunkText("A first clause here, and a second clause there.", 30),
    ["A first clause here,", "and a second clause there."],
  );
  assertEquals(chunkText("Line one\nLine two", 100), ["Line one", "Line two"]);
  assertEquals(chunkText("  \n\n "), []);
});

Deno.test("no text is lost when a long sentence is split", () => {
  const sentence =
    "We met at 10:30 and paid 1,000 francs for a 2010–2020 map, " +
    "word ".repeat(40).trim() + ", then left.";
  const chunks = chunkText(sentence, 60);
  for (const chunk of chunks) assert(chunk.length <= 60, chunk);
  assertEquals(chunks.join(" "), sentence);
  assert(chunks[0].startsWith("We met at 10:30"));
});

Deno.test("decimal points and abbreviations-in-words do not split", () => {
  assertEquals(chunkText("Version 2.5 is out. Nice.", 12), [
    "Version 2.5",
    "is out.",
    "Nice.",
  ]);
});
