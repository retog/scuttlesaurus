/**
 * Blob descriptions and upload receipts as triples (DATA-MODEL.md, "Blobs").
 * The graph only grows, so every function here either reads or inserts.
 * @module
 */
import type { SparqlBinding, SparqlTerm, TripleStore } from "../types.ts";
import {
  blobHashFromIri,
  blobIri,
  PREFIXES,
  pubkeyIri,
  term,
  XSD,
} from "../vocab.ts";

// --- N-Triples -------------------------------------------------------------

const iri = (value: string): string => `<${value}>`;
const integer = (value: number): string => `"${value}"^^<${XSD}integer>`;

function statement(s: string, p: Parameters<typeof term>[0], o: string) {
  return `${iri(s)} ${iri(term(p))} ${o} .\n`;
}

/**
 * The triples describing a blob. Only written for a blob without a
 * description yet. `type` must already be validated (see `mediaTypeOf`).
 */
export function describeBlobNTriples(
  sha256: string,
  size: number,
  type: string,
): string {
  const blob = blobIri(sha256);
  return statement(blob, "blobSize", integer(size)) +
    statement(blob, "blobType", `"${type}"`);
}

/** The triples of a new upload receipt. */
export function receiptNTriples(
  receipt: string,
  sha256: string,
  pubkey: string,
  uploadedAt: number,
): string {
  return statement(receipt, "blob", iri(blobIri(sha256))) +
    statement(receipt, "uploadedBy", iri(pubkeyIri(pubkey))) +
    statement(receipt, "uploadedAt", integer(uploadedAt));
}

/** The triples that void the given receipts. */
export function removalNTriples(receipts: string[], removedAt: number): string {
  return receipts.map((receipt) =>
    statement(receipt, "removedAt", integer(removedAt))
  ).join("");
}

// --- queries ---------------------------------------------------------------

/** A blob's stored description. */
export interface StoredBlob {
  size: number;
  type: string | undefined;
}

/** The description of a blob, if it has one. */
export async function storedBlob(
  triples: TripleStore,
  sha256: string,
): Promise<StoredBlob | undefined> {
  const rows = await triples.select(`${PREFIXES}
    SELECT ?size ?type WHERE {
      ${iri(blobIri(sha256))} nostr:blobSize ?size .
      OPTIONAL { ${iri(blobIri(sha256))} nostr:blobType ?type }
    } LIMIT 1`);
  const row = rows[0];
  if (row === undefined) return undefined;
  return { size: Number(value(row, "size")), type: optional(row, "type") };
}

/** A receipt that has not been removed. */
export interface LiveReceipt {
  /** The receipt's IRI, `urn:uuid:<uuid>`. */
  receipt: string;
  /** Unix seconds. */
  uploadedAt: number;
}

/**
 * The live receipts of a blob: all of them, or only those of one uploader.
 */
export async function liveReceipts(
  triples: TripleStore,
  sha256: string,
  uploader?: string,
): Promise<LiveReceipt[]> {
  const byUploader = uploader === undefined
    ? ""
    : `?receipt nostr:uploadedBy ${iri(pubkeyIri(uploader))} .`;
  const rows = await triples.select(`${PREFIXES}
    SELECT ?receipt ?uploadedAt WHERE {
      ?receipt nostr:blob ${iri(blobIri(sha256))} ;
               nostr:uploadedAt ?uploadedAt .
      ${byUploader}
      MINUS { ?receipt nostr:removedAt ?removed }
    }`);
  return rows.map((row) => ({
    receipt: value(row, "receipt"),
    uploadedAt: Number(value(row, "uploadedAt")),
  }));
}

/** A blob with a live receipt of some uploader. */
export interface ListedBlob {
  sha256: string;
  size: number;
  type: string | undefined;
  /** Unix seconds of the receipt. */
  uploadedAt: number;
}

/**
 * The blobs with a live receipt of an uploader, newest first, optionally
 * restricted to receipts with `since <= uploadedAt <= until`.
 */
export async function listLiveBlobs(
  triples: TripleStore,
  uploader: string,
  range: { since?: number; until?: number },
): Promise<ListedBlob[]> {
  const conditions: string[] = [];
  if (range.since !== undefined) {
    conditions.push(`?uploadedAt >= ${range.since}`);
  }
  if (range.until !== undefined) {
    conditions.push(`?uploadedAt <= ${range.until}`);
  }
  const filter = conditions.length > 0
    ? `FILTER (${conditions.join(" && ")})`
    : "";
  const rows = await triples.select(`${PREFIXES}
    SELECT ?blob ?uploadedAt ?size ?type WHERE {
      ?receipt nostr:uploadedBy ${iri(pubkeyIri(uploader))} ;
               nostr:blob ?blob ;
               nostr:uploadedAt ?uploadedAt .
      MINUS { ?receipt nostr:removedAt ?removed }
      ?blob nostr:blobSize ?size .
      OPTIONAL { ?blob nostr:blobType ?type }
      ${filter}
    }
    ORDER BY DESC(?uploadedAt)`);
  return rows.map((row) => ({
    sha256: blobHashFromIri(value(row, "blob")),
    size: Number(value(row, "size")),
    type: optional(row, "type"),
    uploadedAt: Number(value(row, "uploadedAt")),
  }));
}

function value(row: SparqlBinding, name: string): string {
  const cell: SparqlTerm | undefined = row[name];
  if (cell === undefined) throw new Error(`Missing binding ${name}`);
  return cell.value;
}

function optional(row: SparqlBinding, name: string): string | undefined {
  const cell: SparqlTerm | undefined = row[name];
  return cell?.value;
}
