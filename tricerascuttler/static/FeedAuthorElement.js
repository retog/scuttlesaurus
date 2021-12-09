async function getDescription(feedUri) {
  const query = `PREFIX ssb: <ssb:ontology:>

  SELECT ?name ?description ?image {
    ?about ssb:content ?aboutContent.
    ?aboutContent ssb:about <${feedUri}>.
    OPTIONAL {  ?aboutContent ssb:name ?name }
    OPTIONAL {  ?aboutContent ssb:description ?description }
    OPTIONAL {  ?aboutContent ssb:image ?image }
  }`; //TODO sort
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
  let name = undefined;
  let description, image;
  for (const binding of resultJson.results.bindings) {
    if (binding.name?.value) {
      name = binding.name?.value;
    }
    if (binding.description?.value) {
      description = binding.description?.value;
    }
    if (binding.image?.value) {
      image = binding.image?.value;
    }
  }
  return { name, description, image };
}

export class FeedAuthorElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    const feedUri = this.getAttribute("src");
    getDescription(feedUri).then(
      ({ name, description, image }) => {
        const template = `
      <style>
        :host {
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          background-color: pink;
        }
    
        div {
          border-style: solid;
          margin: 5pt;
          padding: 5pt;
        }
      </style>
    
      <div>
      id: ${feedUri}<br/>
      name: ${name} <br/>
      desc: ${description}<br/>
      image: ${image}</br>
      </div>
      <slot></slot>
    `;
        console.log(this);
        this.shadowRoot.innerHTML = template;
      },
    );
  }
}
window.customElements.define("ssb-feed-author", FeedAuthorElement);
