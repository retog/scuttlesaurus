import { assert, assertEquals } from "@std/assert";
import oxigraph from "oxigraph";
import { NOSTR, TERMS } from "../vocab.ts";

const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const CLASSES = [
  "Event",
  "PublicKey",
  "Address",
  "Relay",
  "Blob",
  "BlobUpload",
];

function loadOntology(): oxigraph.Store {
  const store = new oxigraph.Store();
  const turtle = Deno.readTextFileSync(
    new URL("../../vocab/nostr.ttl", import.meta.url),
  );
  store.load(turtle, { format: "text/turtle", base_iri: "nostr:ontology:" });
  return store;
}

function select(
  store: oxigraph.Store,
  sparql: string,
): Record<string, { value: string }>[] {
  const json = store.query(sparql, {
    results_format: "application/sparql-results+json",
  }) as string;
  return JSON.parse(json).results.bindings;
}

Deno.test("vocab/nostr.ttl describes every term with a label and comment", () => {
  const store = loadOntology();
  for (const local of Object.values(TERMS)) {
    const iri = NOSTR + local;
    const rows = select(
      store,
      `SELECT ?label ?comment WHERE { <${iri}> <${RDFS}label> ?label ; <${RDFS}comment> ?comment }`,
    );
    assert(rows.length > 0, `${iri} has no label and comment`);
    const [type] = select(
      store,
      `SELECT ?t WHERE { <${iri}> <${RDF}type> ?t }`,
    );
    assert(type, `${iri} has no type`);
  }
});

Deno.test("vocab/nostr.ttl declares the classes and describes nothing unknown", () => {
  const store = loadOntology();
  for (const name of CLASSES) {
    const rows = select(
      store,
      `SELECT ?l WHERE { <${NOSTR}${name}> a <${RDFS}Class> ; <${RDFS}label> ?l }`,
    );
    assertEquals(rows.length, 1, name);
  }
  const known = new Set(
    [...Object.values(TERMS), ...CLASSES].map((n) => NOSTR + n),
  );
  const subjects = select(
    store,
    `SELECT DISTINCT ?s WHERE { ?s a ?t . FILTER(STRSTARTS(STR(?s), "${NOSTR}")) }`,
  ).map((row) => row.s.value);
  for (const subject of subjects) {
    assert(
      known.has(subject) || subject === NOSTR,
      `unexpected term ${subject}`,
    );
  }
});

Deno.test("vocab/nostr.ttl domains and ranges refer to declared classes", () => {
  const store = loadOntology();
  const declared = new Set(CLASSES.map((n) => NOSTR + n));
  const rows = select(
    store,
    `SELECT ?c WHERE { { ?p <${RDFS}domain> ?c } UNION { ?p <${RDFS}range> ?c } FILTER(STRSTARTS(STR(?c), "${NOSTR}")) }`,
  );
  for (const row of rows) assert(declared.has(row.c.value), row.c.value);
});
