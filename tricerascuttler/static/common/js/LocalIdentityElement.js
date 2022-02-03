import { FeedId } from "./ext/scuttlebutt-host.js";
export class LocalIdentityElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  async connectedCallback() {
    this.shadowRoot.innerHTML = `
    <main id="main">
    <h1>Your identity</h1>
    <p>This is your Scuttlebutt identity. It is stored in this browser.</p>
    ${
      new FeedId((await window.scuttlebuttHost).getClientKeyPair().publicKey)
        .toString()
    }
    <p>
        You can download the identity an use it with another Scuttlebutt client or upload an identity
        created
        elsewhere, however you must no use the same identity with multiple clients as this would fork
        and thus
        invalidate your feed.
        After transfering your identity give the new client enough time to get your latest messages
        before creating
        new messages.</p>
    </main>
    `;
  }
}
window.customElements.define("ssb-local-identity", LocalIdentityElement);
