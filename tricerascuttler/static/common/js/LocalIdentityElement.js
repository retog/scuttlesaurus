import {
  FeedId,
  parseKeyPair,
  serializeKeyPair,
  toBase64,
} from "./ext/scuttlebutt-host.js";
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
    <style>
    .visually-hidden {
      position: absolute !important;
      height: 1px;
      width: 1px;
      overflow: hidden;
      clip: rect(1px, 1px, 1px, 1px);
    }
    
    /* Separate rule for compatibility, :focus-within is required on modern Firefox and Chrome */
    input.visually-hidden:focus + label {
      outline: thin dotted;
    }
    input.visually-hidden:focus-within + label {
      outline: thin dotted;
    }
    .action {
      display: block;
      letter-spacing: 3px;
      border: none;
      padding: 10px;
      margin: 10px;
      background-color: #bccbe9;
      color: #232c3d;
      font-size: 18px;
      cursor: pointer;
      transition: 0.5s;
      box-shadow: 0px 5px 15px rgba(0, 0, 0, .2);
    }
    </style>    
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
        elsewhere, however you must not use the same identity with multiple clients as this would fork
        and thus
        invalidate your feed.
        After transfering your identity give the new client enough time to get your latest messages
        before creating
        new messages.</p>
        <div id="actions">
          <a download="secret.json" class="action" href="${certURL}">Download Identity Secret</a>
          <input type="file" id="upload" class="visually-hidden">
          <label for="upload" class="action" >Upload Identity Secret</label>
        </div>
        </main>
    `;


    const uploadElement = this.shadowRoot.getElementById("upload");
    uploadElement.addEventListener("change", handleFiles, false);
    async function handleFiles() {
      const file = this.files[0];
      const text = await file.text();
      const newKey = parseKeyPair(text);
      if (
        window.confirm(
          `Irreversibly become ${
            new FeedId(
              newKey.publicKey,
            )
              .toString()
          }`,
        )
      ) {
        localStorage.setItem("ssb-identity", serializeKeyPair(newKey));
        window.location.reload();
      }
    }
  }
}
window.customElements.define("ssb-local-identity", LocalIdentityElement);
