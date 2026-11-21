/**
 * Tests of the command line of the seed.
 * @module
 */
import { assertEquals, assertThrows } from "@std/assert";
import {
  DEFAULT_OWNER,
  DEFAULT_URL,
  parseOptions,
  UsageError,
} from "./options.ts";

Deno.test("no arguments: the default node and owner", () => {
  assertEquals(parseOptions([]), {
    url: DEFAULT_URL,
    owner: DEFAULT_OWNER,
    quiet: false,
    help: false,
  });
});

Deno.test("values may follow the flag or come after an equals sign", () => {
  const options = parseOptions([
    "--url",
    "http://127.0.0.1:8080",
    "--owner=ada",
    "--quiet",
  ]);
  assertEquals(options.url, "http://127.0.0.1:8080");
  assertEquals(options.owner, "ada");
  assertEquals(options.quiet, true);
});

Deno.test("hub is an owner", () => {
  assertEquals(parseOptions(["--owner", "hub"]).owner, "hub");
});

Deno.test("unknown owners, URLs and flags are usage errors", () => {
  assertThrows(() => parseOptions(["--owner", "nobody"]), UsageError);
  assertThrows(
    () => parseOptions(["--url", "ws://127.0.0.1:7777"]),
    UsageError,
  );
  assertThrows(() => parseOptions(["--url", "not a url"]), UsageError);
  assertThrows(() => parseOptions(["--frobnicate"]), UsageError);
  assertThrows(() => parseOptions(["--url"]), UsageError);
});

Deno.test("a separator passed on by deno task is ignored", () => {
  assertEquals(parseOptions(["--", "--owner", "hub"]).owner, "hub");
});
