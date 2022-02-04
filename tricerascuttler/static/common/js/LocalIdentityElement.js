import { FeedId, toBase64 } from "./ext/scuttlebutt-host.js";
export class LocalIdentityElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  async connectedCallback() {
    const certBlob = new Blob([
      serializeKeyPair(
        (await window.scuttlebuttHost).getClientKeyPair(),
      ),
    ], { type: "application/json" });
    const certURL = URL.createObjectURL(certBlob);
    this.shadowRoot.innerHTML = `
    <main id="main">
    <h1>Your identity</h1>
    <p>This is your Scuttlebutt identity. It is stored in this browser.</p>
    ${
      new FeedId((await window.scuttlebuttHost).getClientKeyPair().publicKey)
        .toString()
    }
    <p>
        You can download your identity secret an use it with another Scuttlebutt client or upload an identity
        created
        elsewhere, however you must no use the same identity with multiple clients as this would fork
        and thus
        invalidate your feed.
        After transfering your identity give the new client enough time to get your latest messages
        before creating
        new messages.</p>
        <div id="links"></div>
    </main>
    `;

    const links = this.shadowRoot.getElementById("links");
    const link = document.createElement("a");
    link.download = "secret.json";
    link.href = certURL;
    link.innerText = "Download Identity Secret";

    links.appendChild(link);
  }
}
window.customElements.define("ssb-local-identity", LocalIdentityElement);

function serializeKeyPair(keyPair) {
  const secret = {
    public: toBase64(keyPair.publicKey) + ".ed25519",
    "private": toBase64(keyPair.privateKey) + ".ed25519",
    curve: keyPair.keyType,
  };
  return JSON.stringify(secret, undefined, 2);
}
