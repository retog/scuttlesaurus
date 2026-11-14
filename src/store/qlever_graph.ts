/**
 * The file and graph naming of the qlever-dir store: where batch files go,
 * the graph IRI qlever-dir derives from a file's path, and the syntax check
 * that keeps a malformed line from making qlever-dir discard a whole file.
 *
 * @module
 */

/** The predicate qlever-dir uses to report a file it could not parse. */
export const PARSING_ERROR = "urn:qlever-dir:parsingError";

/** The graph IRI qlever-dir derives for a file: `BASE_URI` + escaped path. */
export function graphIri(baseUri: string, relativePath: string): string {
  // The same escaping as `urlencode_relpath` in qlever-dir's emit_file.sh.
  const safe = "/-._~!$&'()*+,;=:@";
  let out = "";
  for (const ch of relativePath) {
    const code = ch.codePointAt(0)!;
    out += code > 127 || safe.includes(ch) || /[A-Za-z0-9]/.test(ch)
      ? ch
      : [...new TextEncoder().encode(ch)].map((b) =>
        "%" + b.toString(16).toUpperCase().padStart(2, "0")
      ).join("");
  }
  // Our own file names need no escaping; if one ever did, the graph IRI
  // computed here must not silently diverge from the one qlever-dir uses.
  if (out !== relativePath) {
    throw new Error(`File path needs escaping in a graph IRI: ${relativePath}`);
  }
  return baseUri + out;
}

/** `YYYY/MM/DD` of the UTC day of `date`. */
export function dayPath(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}`;
}

const IRIREF = String.raw`<[^\x00-\x20<>"{}|^\`\\]+>`;
const STRING = String
  .raw`"(?:[^"\\\n\r]|\\[tbnrf"'\\]|\\u[0-9A-Fa-f]{4}|\\U[0-9A-Fa-f]{8})*"`;
const TRIPLE = new RegExp(
  `^(?:${IRIREF}|_:[A-Za-z0-9_][A-Za-z0-9_.-]*) ${IRIREF} ` +
    `(?:${IRIREF}|_:[A-Za-z0-9_][A-Za-z0-9_.-]*|${STRING}` +
    `(?:\\^\\^${IRIREF}|@[A-Za-z]+(?:-[A-Za-z0-9]+)*)?) \\.$`,
);

/**
 * Check that every line of an N-Triples document looks like a triple:
 * subject and predicate, an object, the terminating ` .`. This is a cheap
 * plausibility check, not a parser; it exists because qlever-dir replaces a
 * file that fails to parse as a whole by a single error triple, so one bad
 * line would hide a whole batch. Throws naming the first offending line.
 */
export function assertPlausibleNTriples(ntriples: string): void {
  if (!ntriples.isWellFormed()) {
    throw new Error("N-Triples is not well-formed Unicode");
  }
  const lines = ntriples.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === "" && i === lines.length - 1) continue;
    if (!TRIPLE.test(lines[i])) {
      throw new Error(
        `Not a valid N-Triples line (${i + 1}): ${lines[i].slice(0, 120)}`,
      );
    }
  }
}
