/**
 * Blob bytes on disk, in `<dataDir>/blobs/`: one file per blob, named by its
 * SHA-256, plus temporary files while an upload is in progress.
 * @module
 */
import { join } from "@std/path";
import type { Config } from "../types.ts";

/** The directory holding the blob files. */
export function blobsDir(config: Config): string {
  return join(config.dataDir, "blobs");
}

/** The file of a blob. */
export function blobPath(config: Config, sha256: string): string {
  return join(blobsDir(config), sha256);
}

/** A fresh temporary file name for an upload, in the blob directory. */
export function tempPath(config: Config): string {
  return join(blobsDir(config), `.upload-${crypto.randomUUID()}.tmp`);
}

/** Whether a file exists. */
export async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/** Remove a file if it is there. */
export async function removeQuietly(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}
