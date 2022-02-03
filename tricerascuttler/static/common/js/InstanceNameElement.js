import { getDescription } from "./FeedAuthorElement.js";
import { mainIdentity } from "./web-util.js";

export class InstanceNameElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  async connectedCallback() {
    const feedUri = await mainIdentity();
    getDescription(feedUri).then(
      ({ name }) => {
        this.shadowRoot.textContent = name
          ? name
          : feedUri.substring(0, 23) + "...";
      },
    );
  }
}
window.customElements.define("ssb-instance-name", InstanceNameElement);
