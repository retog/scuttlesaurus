import {
  handleSsbLinks,
  iriToSigil,
  mdToHtml,
  runQuery,
  sigilToIri,
} from "./web-util.js";

export async function getDescription(feedUri) {
  const query = `PREFIX ssb: <ssb:ontology:>

  SELECT ?name ?description ?image {
    ?about ssb:content ?aboutContent.
    ?about ssb:timestamp ?timestamp.
    ?aboutContent ssb:about <${feedUri}>.
    OPTIONAL {  ?aboutContent ssb:name ?name }
    OPTIONAL {  ?aboutContent ssb:description ?description }
    OPTIONAL {  ?aboutContent ssb:image ?image }
  } ORDER BY ASC(?timestamp)`;

  const resultJson = await runQuery(query);
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
    this.feedUri = this.getAttribute("src");
  }

  async connectedCallback() {
    const mode = this.getAttribute("mode");
    const { name, description, image } = await getDescription(this.feedUri);
    const renderedDescription = description
      ? mode === "small"
        ? description.substring(0, 80)
        : mdToHtml(description) +
          "<br/>"
      : "";

    const template = `
      <style>
        :host {
          background-color: lavenderblush;
        }
    
        div {
          border-style: solid;
          margin: 5pt;
          padding: 5pt;
        }
        ${
      mode === "small"
        ? `img {
            max-width: 40px;
            max-height: 40px;
          }`
        : `img {
              max-width: 100%;
            }`
    }
      </style>
    
      <div>
      <a href="/?uri=${this.feedUri}">${
      name ? name : this.feedUri.substring(0, 23) + "..."
    }</a>
      ${renderedDescription}
      ${image ? `<img src="${image.replace("ssb:blob/", "./blob/")}">` : ""}
      </div>
      <slot></slot>
    `;
    this.shadowRoot.innerHTML = template;
    handleSsbLinks(this.shadowRoot);
    this.shadowRoot.append(await this.createFollowUnFollowButton());
    const copyUriButton = document.createElement("button");
    copyUriButton.innerHTML = "Copy URI";
    copyUriButton.onclick = async () => {
      try {
        await navigator.clipboard.writeText(this.feedUri);
        alert("Message URI copied to clipboard");
      } catch (_error) {
        console.log(`Failed writing to clipboard: ${this.feedUri}`);
      }
    };
    this.shadowRoot.append(copyUriButton);
    const copySigilButton = document.createElement("button");
    copySigilButton.innerHTML = "Copy Sigil";
    copySigilButton.onclick = async () => {
      try {
        await navigator.clipboard.writeText(iriToSigil(this.feedUri));
        alert("Message Sigil copied to clipboard");
      } catch (_error) {
        console.log(`Failed writing to clipboard: ${iriToSigil(this.feedUri)}`);
      }
    };
    this.shadowRoot.append(copySigilButton);
  }

  async createFollowUnFollowButton() {
    const scuttlebuttHost = await window.scuttlebuttHost;
    const localId = sigilToIri(scuttlebuttHost.identity.toString());
    if (this.feedUri === localId.toString()) {
      return document.createElement("span");
    }
    let isFollowing = (await runQuery(`ASK { 
      <${localId}> <ssb:ontology:derivatives:follows> <${this.feedUri}>. 
    } `)).boolean;
    const button = document.createElement("button");
    const setLabel = () =>
      button.innerHTML = isFollowing ? "Unfollow" : "Follow";
    setLabel();
    button.onclick = async () => {
      await scuttlebuttHost.publish({
        type: "contact",
        contact: iriToSigil(this.feedUri),
        following: !isFollowing,
      });
      isFollowing = !isFollowing;
      setLabel();
    };
    return button;
  }
}
window.customElements.define("ssb-feed-author", FeedAuthorElement);
