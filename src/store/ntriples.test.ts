import { assert, assertEquals, assertThrows } from "@std/assert";
import oxigraph from "oxigraph";
import {
  date,
  dateLiteral,
  integer,
  iri,
  isIriref,
  literal,
  Triples,
  utcDay,
  webIri,
} from "./ntriples.ts";

function roundTrip(value: string): string {
  const store = new oxigraph.Store();
  store.load(`<urn:s> <urn:p> ${literal(value)} .\n`, {
    format: "application/n-triples",
  });
  const json = store.query("SELECT ?o WHERE { ?s ?p ?o }", {
    results_format: "application/sparql-results+json",
  }) as string;
  return JSON.parse(json).results.bindings[0].o.value;
}

Deno.test("literal escapes and round-trips awkward strings", () => {
  const samples = [
    "",
    'quote " and backslash \\ and \\n literal',
    "line\nbreak\r\ncarriage\ttab",
    "\u0000\u0001\u001f\u007f control",
    "emoji 🦖 and ‮RTL‬ and   separator",
    '"; DROP <> {} | ^ `',
    " . <urn:evil> <urn:p> <urn:o> . ",
  ];
  for (const sample of samples) assertEquals(roundTrip(sample), sample);
});

Deno.test("literal refuses ill-formed Unicode", () => {
  assertThrows(() => literal("lone \ud800 surrogate"));
});

Deno.test("literal output cannot end the statement early", () => {
  const text = literal('x" . <urn:a> <urn:b> <urn:c> .\n<urn:d> <urn:e> "');
  assert(!text.includes("\n"));
  const store = new oxigraph.Store();
  store.load(`<urn:s> <urn:p> ${text} .\n`, {
    format: "application/n-triples",
  });
  assertEquals(store.size, 1);
});

Deno.test("iri accepts valid IRIs and rejects hostile ones", () => {
  assertEquals(iri("nostr:note1abc"), "<nostr:note1abc>");
  for (
    const bad of [
      "",
      "a b",
      "a>b",
      "a<b",
      'a"b',
      "a{b",
      "a|b",
      "a^b",
      "a`b",
      "a\\b",
      "a\nb",
      "a\u0000b",
      "\ud800",
    ]
  ) {
    assert(!isIriref(bad), JSON.stringify(bad));
    assertThrows(() => iri(bad), Error, "Invalid IRI");
  }
});

Deno.test("webIri accepts only absolute web IRIs", () => {
  assertEquals(
    webIri("https://example.com/a.png"),
    "https://example.com/a.png",
  );
  assertEquals(webIri("wss://relay.example.com/"), "wss://relay.example.com/");
  assertEquals(
    webIri("https://example.com/ü"),
    "https://example.com/%C3%BC",
  );
  for (
    const bad of [
      "javascript:alert(1)",
      "ftp://example.com/",
      "/relative",
      "example.com",
      "https://",
      "https://exa mple.com/",
      "https://example.com/a b",
      "https://example.com/%zz",
      'https://example.com/"><',
      "https://example.com/\ud800",
      42,
      undefined,
    ]
  ) {
    assertEquals(webIri(bad), undefined, String(bad));
  }
});

Deno.test("integer, date and Triples", () => {
  assertEquals(integer(5), '"5"^^<http://www.w3.org/2001/XMLSchema#integer>');
  assertThrows(() => integer(1.5));
  assertThrows(() => integer(NaN));
  assertEquals(utcDay(0), "1970-01-01");
  assertEquals(utcDay(1794528000), "2026-11-13");
  assertEquals(utcDay(86399), "1970-01-01");
  assertEquals(
    date(86400),
    '"1970-01-02"^^<http://www.w3.org/2001/XMLSchema#date>',
  );
  assertThrows(() => dateLiteral("tomorrow"));
  const triples = new Triples().add("<urn:a>", "<urn:b>", literal("c"));
  assertEquals(triples.length, 1);
  assertEquals(String(triples), '<urn:a> <urn:b> "c" .\n');
  assertEquals(String(new Triples()), "");
});
