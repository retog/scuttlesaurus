import {
  mainIdentity,
} from "./web-util.js";
import * as _postList from "./PostListElement.js";

export class CircleElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  async connectedCallback() {
    this.shadowRoot.innerHTML = `
        <ssb-post-list query="PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
                    PREFIX ssb: <ssb:ontology:>
                    PREFIX ssbx: <ssb:ontology:derivatives:>
                    SELECT ?post {
                        ?post ssb:timestamp ?timestamp;
                            ssb:author ?author;
                            ssb:content ?content.
                        ?content rdf:type ssb:Post.
                        <${await mainIdentity()}> ssbx:follows ?author.
                    } ORDER BY DESC(?timestamp)"></ssb-post-list>
                  `;
  }
}
window.customElements.define("ssb-circle", CircleElement);
