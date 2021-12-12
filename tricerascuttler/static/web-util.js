export function sigilToIri(sigil) {
  const hashPart = sigil.substring(1, sigil.lastIndexOf("."));
  const safeHashPart = hashPart.replaceAll("/", "_").replaceAll("+", "-");
  switch (sigil[0]) {
    case "@":
      return "ssb:feed/ed25519/" + safeHashPart;
    case "&":
      return "ssb:blob/sha256/" + safeHashPart;
    case "%":
      return "ssb:message/sha256/" + safeHashPart;
    default:
      throw new Error("unrecognized sigil type: " + sigil);
  }
}

export async function mainIdentity() {
  const response = await fetch("/whoami");
  const whoami = await response.json();
  return whoami.feedId;
}
