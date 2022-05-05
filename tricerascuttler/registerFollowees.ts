import ScuttlebuttHost from "../scuttlesaurus/ScuttlebuttHost.ts";
import { FeedId, log, parseFeedId } from "../scuttlesaurus/util.ts";

const sigilPrefix: Record<string, string> = {
  feed: "@",
  blob: "&",
  message: "%",
};

function iriToSigil(iri: string) {
  const postPrefix = iri.substring(4);
  const [type, cypher, safeHashPart] = postPrefix.split("/");
  const hashPart = safeHashPart.replaceAll("_", "/").replaceAll("-", "+");
  return `${sigilPrefix[type]}${hashPart}.${cypher}`;
}

export default async function registerFollowees(
  identity: FeedId,
  host: ScuttlebuttHost,
  sparqlEndpoint: string,
) {
  const query = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    PREFIX ssb: <ssb:ontology:>
    PREFIX ssbx: <ssb:ontology:derivatives:>
    SELECT DISTINCT * { 
    <${identity.toUri()}> ssbx:follows/ssbx:follows? ?contact .
    } `;
  const response = await fetch(sparqlEndpoint, {
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
  const resultJson = await response.json();
  // deno-lint-ignore no-explicit-any
  resultJson.results.bindings.forEach((binding: any) => {
    try {
      host.followees.add(parseFeedId(iriToSigil(binding.contact.value)));
    } catch (e) {
      log.warning(`Processing: ${binding.contact.value}: ${e}`);
    }
  });
}
