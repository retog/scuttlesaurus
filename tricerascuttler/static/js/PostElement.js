import { handleSsbLinks, iriToSigil, mdToHtml, runQuery } from "./web-util.js";
import * as _feedAuthor from "./FeedAuthorElement.js";
export class PostElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    const msgUri = this.getAttribute("src");
    runQuery(`PREFIX ssb: <ssb:ontology:>
        SELECT ?timestamp ?text ?root ?author WHERE {
            <${msgUri}> ssb:timestamp ?timestamp;
                        ssb:content ?content;
                        ssb:author ?author.
            ?content ssb:text ?text.
            OPTIONAL {?content ssb:root ?root}
        }`).then((result) => {
      const bindings = result.results.bindings;
      if (bindings.lengh === 0) {
        this.shadowRoot.innerHTML = `Don't know anything about ${msgUri}`;
      } else {
        this.shadowRoot.innerHTML = `
        <style>
        :host {
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          background-color: lightgrey;
          border-style: solid;
          margin: 5pt;
          padding: 5pt;
        }
      </style>
            Text: ${mdToHtml(bindings[0].text?.value)}<br>
            Timestamp: ${bindings[0].timestamp?.value}<br>
            Author: <ssb-feed-author src="${
          bindings[0].author.value
        }" mode="small" ></ssb-feed-author>`;
      }
    });
  }
}
window.customElements.define("ssb-post", PostElement);
