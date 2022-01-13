import { handleSsbLinks, runQuery } from "./web-util.js";
import removeMd from "./ext/remove-markdown.js";
export class PostLinkElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    handleSsbLinks(this.shadowRoot);
    const msgUri = this.getAttribute("href");
    runQuery(`PREFIX ssb: <ssb:ontology:>
        SELECT ?text ?author WHERE {
            <${msgUri}> ssb:content ?content;
                        ssb:author ?author.
            ?content ssb:text ?text.
        }`).then((result) => {
      const bindings = result.results.bindings;
      const link = document.createElement("a");
      this.shadowRoot.appendChild(link);
      link.setAttribute("href", "/?uri=" + msgUri);
      if (!bindings[0]) {
        link.innerHTML = `unavalable message ${msgUri}`;
      } else {
        const text = removeMd(bindings[0].text?.value);
        const firstBreak = text.indexOf("\n");
        const endHeading = firstBreak > 5 && firstBreak < 100
          ? firstBreak
          : text.indexOf(" ", 50);
        link.innerHTML = text.substring(0, endHeading);
      }
    });
  }
}
window.customElements.define("ssb-post-link", PostLinkElement);
