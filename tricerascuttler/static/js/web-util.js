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
      //let's hope it's an iri
      return sigil;
  }
}
const sigilPrefix = {
  feed: "@",
  blob: "&",
  message: "%",
};
export function iriToSigil(iri) {
  const postPrefix = iri.substring(4);
  const [type, cypher, safeHashPart] = postPrefix.split("/");
  const hashPart = safeHashPart.replaceAll("_", "/").replaceAll("-", "+");
  return `${sigilPrefix[type]}${hashPart}.${cypher}`;
}

export async function mainIdentity() {
  const response = await fetch("/whoami");
  const whoami = await response.json();
  return sigilToIri(whoami.feedId);
}

export async function runQuery(query) {
  const response = await fetch("/query", {
    "headers": {
      "Accept": "application/sparql-results+json,*/*;q=0.9",
      "Content-Type": "application/sparql-query",
    },
    "body": query,
    "method": "POST",
  });
  if (response.status >= 300) {
    throw new Error(response.statusText);
  }

  return await response.json();
}
