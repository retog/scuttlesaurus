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
      if (binding.following.value) {
        following.add(contact);
      } else {
        following.delete(contact);
      }
    }
    if (binding.blocking) {
      if (binding.blocking.value) {
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
      width: 100%;
      padding: 15px;
      border: none;
      margin-bottom: 5px;
      box-sizing: border-box;
      font-size: 1rem;
      text-align: center;
      text-decoration: none;
      background: gold;
      color: #000;
      background-color: firebrick;
    }
    .contacts{
      display: grid;
      grid-template-columns: 1fr 1fr;
  }
  
    </style>
    <h1>profile</h1>
    <ssb-feed-author src="${feedUri}"></ssb-feed-author>
    `;
    getFollowees(feedUri).then(
      ({ following, blocking }) => {
        if (following.size > 0) {
          template += `<h2>Following</h2>
          <div class="contacts">
          ${
            [...following].map((f) =>
              `<ssb-feed-author src="${f}" class="contact"></ssb-feed-author>`
            ).join("")
          }
          </div>`;
        }
        if (blocking.size > 0) {
          template += `<h2>Blocking</h2>
          ${
            [...blocking].map((f) =>
              `<ssb-feed-author src="${f}"></ssb-feed-author>`
            ).join("<br>")
          }`;
        }
        console.log(this);
        this.shadowRoot.innerHTML = template;
      },
    );
  }
}
window.customElements.define("ssb-profile", ProfileElement);
