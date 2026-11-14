/**
 * Blob bodies of the seed world. They are generated text (SVG), so the world
 * stays free of files and of network access.
 * @module
 */
import { createHash } from "node:crypto";
import type { Blob } from "./model.ts";

/** The media type of every generated image. */
export const SVG_TYPE = "image/svg+xml";

/** Collects the blobs of a world, keyed by id. */
export class BlobBook {
  readonly #blobs = new Map<string, Blob>();

  /** Adds an SVG document as a blob and returns its id. */
  addSvg(id: string, owner: string, svg: string): string {
    if (this.#blobs.has(id)) throw new Error(`blob ${id} is defined twice`);
    const bytes = new TextEncoder().encode(svg);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    this.#blobs.set(id, { id, owner, type: SVG_TYPE, bytes, sha256 });
    return id;
  }

  /** The blobs in the order they were added. */
  list(): Blob[] {
    return [...this.#blobs.values()];
  }
}
