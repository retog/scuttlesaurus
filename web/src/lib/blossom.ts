/**
 * Media upload to the node's Blossom server (BUD-02).
 *
 * @module
 */
import { sha256Hex } from "./hash.ts";
import { signEvent } from "./session.ts";

/** What the server reports for a stored blob. */
export interface UploadedBlob {
  url: string;
  sha256: string;
  size: number;
  type: string;
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Upload a file with `PUT /upload`, authorized by a signed kind 24242 event
 * (`t=upload`, `x=<sha256>`, expiration five minutes ahead).
 */
export async function uploadBlob(file: File): Promise<UploadedBlob> {
  const sha256 = sha256Hex(new Uint8Array(await file.arrayBuffer()));
  const now = Math.floor(Date.now() / 1000);
  const auth = await signEvent({
    kind: 24242,
    created_at: now,
    content: `Upload ${file.name || sha256}`,
    tags: [["t", "upload"], ["x", sha256], ["expiration", String(now + 300)]],
  });
  let response: Response;
  try {
    response = await fetch("/upload", {
      method: "PUT",
      headers: {
        authorization: `Nostr ${base64(JSON.stringify(auth))}`,
        "content-type": file.type || "application/octet-stream",
      },
      body: file,
    });
  } catch (error) {
    throw new Error(`Upload failed: ${(error as Error).message}`);
  }
  if (!response.ok) {
    const reason = response.headers.get("x-reason") ||
      (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(reason || `Upload failed (HTTP ${response.status})`);
  }
  const descriptor = await response.json() as Partial<UploadedBlob>;
  const url = new URL(
    descriptor.url ?? `/${sha256}`,
    globalThis.location.origin,
  );
  return {
    url: url.href,
    sha256: descriptor.sha256 ?? sha256,
    size: descriptor.size ?? file.size,
    type: descriptor.type ?? file.type,
  };
}
