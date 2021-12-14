import * as _FeedAuth from "./FeedAuthorElement.js";

async function getFollowees(feedUri) {
  const query = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
  PREFIX ssb: <ssb:ontology:>

  SELECT ?contact ?following ?blocking {
    ?msg ssb:author <${feedUri}>;
         ssb:content ?content;
         ssb:seq ?seq.
    ?content rdf:type ssb:Contact;
         ssb:contact ?contact.
    OPTIONAL {  ?content ssb:following ?following }
    OPTIONAL {  ?content ssb:blocking ?blocking }
  } ORDER BY ASC(?seq)`;
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

  const resultJson = await response.json();
  const following = new Set();
  const blocking = new Set();
  //let contact, following, blocking;
  for (const binding of resultJson.results.bindings) {
    const contact = binding.contact.value;

    if (binding.following) {
      if (JSON.parse(binding.following.value)) {
        following.add(contact);
      } else {
        following.delete(contact);
      }
    }
    if (binding.blocking) {
      if (JSON.parse(binding.blocking.value)) {
        blocking.add(contact);
      } else {
        blocking.delete(contact);
      }
    }
  }
  return { following, blocking };
}

export class ProfileElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });

    const feedUri = this.getAttribute("src");

    let template = `
    <style>
    .contact {
      display: block;
      flex: 0 1 150px;
      margin: 5px;
    }
    .contacts{
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
    }
  
    </style>
    <h1>profile</h1>
    <ssb-feed-author src="${feedUri}"></ssb-feed-author>
    `;
    getFollowees(feedUri).then(
      ({ following, blocking }) => {
        if (following.size > 0) {
          template += `<h2>Following (${following.size} feeds)</h2>
          <div class="contacts">
          ${
            [...following].map((f) =>
              `<ssb-feed-author src="${f}" class="contact"></ssb-feed-author>`
            ).join("")
          }
          </div>`;
        }
        if (blocking.size > 0) {
          template += `<h2>Blocking (${blocking.size} feeds)</h2>
          <div class="contacts">
          ${
            [...blocking].map((f) =>
              `<ssb-feed-author src="${f}" class="contact"></ssb-feed-author>`
            ).join("<br>")
          }
          </div>`;
        }
        console.log(this);
        this.shadowRoot.innerHTML = template;
      },
    );
  }
}
window.customElements.define("ssb-profile", ProfileElement);
