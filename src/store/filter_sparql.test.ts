import { assert, assertEquals } from "@std/assert";
import { PREFIXES, pubkeyIri } from "../vocab.ts";
import { buildQuery, parseFilter } from "./filter_sparql.ts";
import type { Filter } from "../types.ts";

const key = (n: number) => n.toString(16).padStart(64, "0");
const query = (filter: Filter) =>
  buildQuery(parseFilter(filter, 100), { projection: "events", limit: 10 });

Deno.test("buildQuery: #p with kinds [1] is the plain tag lookup, as before", () => {
  assertEquals(
    query({ kinds: [1], "#p": [key(1)] }),
    `${PREFIXES}SELECT DISTINCT ?e ?author ?kind ?createdAt ?content ?tags ?sig WHERE {
?e nostr:author ?author ; nostr:kind ?kind ;
   nostr:createdAt ?createdAt ; nostr:sig ?sig .
OPTIONAL { ?e nostr:content ?content }
OPTIONAL { ?e nostr:tags ?tags }
VALUES ?tv0 { "${key(1)}" }
?e tag:p ?tv0 .
FILTER(?kind = "1"^^<http://www.w3.org/2001/XMLSchema#integer>)
MINUS { ?e nostr:deletedBy ?deletion }
MINUS { ?e nostr:supersededBy ?newer }
}
ORDER BY DESC(?createdAt) ?e LIMIT 10`,
  );
});

Deno.test("buildQuery: #p also looks at follows and mutes, as the kinds allow", () => {
  const npub = (n: number) => `<${pubkeyIri(key(n))}>`;
  const tagBranch = `{ VALUES ?tv0 { "${key(1)}" "zz" "${
    key(2)
  }" } ?e tag:p ?tv0 }`;
  const follows = `UNION { VALUES ?tp0 { ${npub(1)} ${
    npub(2)
  } } ?e nostr:follows ?tp0 }`;
  const mutes = `UNION { VALUES ?tp0 { ${npub(1)} ${
    npub(2)
  } } ?e nostr:mutes ?tp0 }`;
  const values = [key(1), "zz", key(2)];
  assert(
    query({ "#p": values }).includes(`${tagBranch}\n${follows}\n${mutes}\n`),
  );
  assert(
    query({ kinds: [1, 3], "#p": values }).includes(
      `${tagBranch}\n${follows}\nFILTER`,
    ),
  );
  assert(
    query({ kinds: [10000], "#p": values }).includes(
      `${tagBranch}\n${mutes}\nFILTER`,
    ),
  );
  // No value is a pubkey: no branch, and never an unbound variable.
  const plain = query({ "#p": ["zz", "AB".repeat(32), key(1).slice(1)] });
  assert(!plain.includes("UNION"), plain);
  assert(plain.includes("?e tag:p ?tv0 ."), plain);
  // `P` is another letter; a second letter is ANDed and keeps its own variable.
  assert(!query({ "#P": [key(1)] }).includes("UNION"));
  const both = query({ "#t": ["x"], "#p": [key(1)] });
  assert(both.includes(`VALUES ?tv0 { "x" }\n?e tag:t ?tv0 .\n{ VALUES ?tv1`));
  assert(both.includes("?e nostr:follows ?tp1 }"));
});
