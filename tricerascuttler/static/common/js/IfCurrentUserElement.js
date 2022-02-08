import { sigilToIri } from "./web-util.js";
import * as _instanceName from "./InstanceNameElement.js";
import * as _feedAuthor from "./FeedAuthorLinkElement.js";
import * as _feedAuthorEditor from "./FeedAuthorEditorElement.js";
export class IfCurrentUserElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  async connectedCallback() {
    const feedUri = this.getAttribute("feed");
    const scuttlebuttHost = await window.scuttlebuttHost;
    const localId = sigilToIri(scuttlebuttHost.identity.toString());
    if (feedUri === localId.toString()) {
      if (
        this.children.length > 0 && this.children[0].tagName === "TEMPLATE"
      ) {
        this.shadowRoot.replaceChildren(
          this.children[0].content.cloneNode(true),
        );
      } else {
        this.shadowRoot.replaceChildren(...this.children);
      }
    }
  }
}
window.customElements.define("ssb-if-current-user", IfCurrentUserElement);
