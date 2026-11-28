/**
 * Safe N-Triples serialization.
 *
 * Event data is hostile input, so nothing is ever concatenated into a document
 * without passing through the functions of this module. They either produce
 * valid N-Triples terms or throw; the mapping code checks candidates with
 * {@link isIriref} / {@link webIri} first and simply omits what is not valid.
 *
 * @module
 */
import { XSD } from "../vocab.ts";

/** Characters that may not appear in an N-Triples `IRIREF`. */
// deno-lint-ignore no-control-regex
const ILLEGAL_IN_IRIREF = /[\x00-\x20<>"{}|^`\\]/;

/** Whether `value` can be written between `<` and `>` as it is. */
export function isIriref(value: string): boolean {
  return value.length > 0 && value.isWellFormed() &&
    !ILLEGAL_IN_IRIREF.test(value);
}

/** An IRI term, `<…>`. Throws if the IRI contains characters illegal in N-Triples. */
export function iri(value: string): string {
  if (!isIriref(value)) throw new Error(`Invalid IRI for N-Triples: ${value}`);
  return `<${value}>`;
}

/**
 * The canonical form of `value` if it is an absolute `http:`, `https:`, `ws:`
 * or `wss:` IRI without characters that are illegal in N-Triples, otherwise `undefined`. ASCII input
 * is kept verbatim; input with other characters is percent-encoded by the URL
 * parser so that the stricter RFC 3987 checks of RDF parsers cannot reject it.
 */
export function webIri(value: unknown): string | undefined {
  if (typeof value !== "string" || !isIriref(value)) return undefined;
  if (!/^(https?|wss?):\/\//i.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    return undefined;
  }
  const ascii = /^[!-~]*$/.test(value);
  const candidate = ascii ? value : url.href;
  // RDF parsers reject malformed percent escapes that URL parsers tolerate.
  if (/%(?![0-9a-fA-F]{2})/.test(candidate)) return undefined;
  return isIriref(candidate) ? candidate : undefined;
}

/**
 * A plain string literal. Escapes backslash, quote, line breaks and all other
 * control characters. Throws on strings that are not well-formed Unicode,
 * because those cannot be represented in UTF-8 and would silently change.
 *
 * The output is also safe to embed in a SPARQL query or update. SPARQL lets an
 * engine replace `\uXXXX` and `\UXXXXXXXX` escapes in the whole query text
 * before tokenising (SPARQL 1.1, section 19.2), and QLever does, so an escaped
 * backslash followed by `u` (`\\u0026`) would turn into the invalid `\` +
 * `&`. A `u` or `U` right after an escaped backslash is therefore written
 * as `u` / `U`, which no pre-processing pass can combine with the
 * backslash before it; N-Triples parsers read it as the same character.
 */
export function literal(value: string): string {
  if (!value.isWellFormed()) {
    throw new Error("String is not well-formed Unicode");
  }
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x5c) {
      out += "\\\\";
      const next = value[i + 1];
      if (next === "u" || next === "U") {
        out += next === "u" ? "\\u0075" : "\\u0055";
        i++;
      }
    } else if (c === 0x22) out += '\\"';
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    else if (c < 0x20 || c === 0x7f) {
      out += "\\u" + c.toString(16).toUpperCase().padStart(4, "0");
    } else out += value[i];
  }
  return `"${out}"`;
}

/** An `xsd:integer` literal. */
export function integer(value: number): string {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Not a safe integer: ${value}`);
  }
  return `"${value}"^^<${XSD}integer>`;
}

/** The UTC day of a Unix timestamp, `YYYY-MM-DD`. */
export function utcDay(unixSeconds: number): string {
  return dayNumberToIso(Math.floor(unixSeconds / 86400));
}

/** `YYYY-MM-DD` for a number of days since 1970-01-01 (clamped to years 0–9999). */
export function dayNumberToIso(day: number): string {
  const clamped = Math.min(Math.max(day, -719162), 2932896);
  return new Date(clamped * 86400_000).toISOString().slice(0, 10);
}

/** An `xsd:date` literal for an ISO day such as `2026-11-13`. */
export function dateLiteral(isoDay: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDay)) {
    throw new Error(`Not an ISO day: ${isoDay}`);
  }
  return `"${isoDay}"^^<${XSD}date>`;
}

/** An `xsd:date` literal for the UTC day of a Unix timestamp. */
export function date(unixSeconds: number): string {
  return dateLiteral(utcDay(unixSeconds));
}

/** Collects triples and renders them as an N-Triples document. */
export class Triples {
  readonly #lines: string[] = [];

  /** Add a triple; all three arguments must already be serialized terms. */
  add(subject: string, predicate: string, object: string): this {
    this.#lines.push(`${subject} ${predicate} ${object} .`);
    return this;
  }

  /** Number of triples collected. */
  get length(): number {
    return this.#lines.length;
  }

  /** The N-Triples document, one triple per line, newline-terminated. */
  toString(): string {
    return this.#lines.length ? this.#lines.join("\n") + "\n" : "";
  }
}
