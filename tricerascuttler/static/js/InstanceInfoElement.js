import * as _PostElement from "./PostElement.js";
import { mainIdentity, runQuery } from "./web-util.js";

async function countTriples() {
  const result = await runQuery(
    `SELECT (COUNT(*) as ?count) WHERE { ?s ?p ?o}`,
  );
  return parseInt(result.results.bindings[0].count.value);
}

async function countMessages() {
  const result = await runQuery(
    `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
      PREFIX ssb: <ssb:ontology:>

      SELECT (COUNT(DISTINCT ?s) as ?count) WHERE { ?s rdf:type ssb:Message}`,
  );
  return parseInt(result.results.bindings[0].count.value);
}

export class InstanceInfoElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  async connectedCallback() {
    this.shadowRoot.innerHTML += `
    <h1>This instance</h1>
    <ul>
    <li>Messages: <span id="messageCount"></span></li>
    <li>Triples: <span id="tripleCount"></span></li>
    <li>Identity: <ssb-feed-author src="${await mainIdentity()}"></ssb-feed-author></li>
    </ul>
    `;
    const messageCount = this.shadowRoot.getElementById("messageCount");
    countMessages().then((c) => {
      messageCount.textContent = c.toLocaleString();
    });
    const tripleCount = this.shadowRoot.getElementById("tripleCount");
    countTriples().then((c) => {
      tripleCount.textContent = c.toLocaleString();
    });
  }
}
window.customElements.define("ssb-instance-info", InstanceInfoElement);
