import {
  FeedId,
  parseAddress,
  parseKeyPair,
  serializeKeyPair,
} from "./ext/scuttlebutt-host.js";
import { sigilToIri } from "./web-util.js";
import * as _instanceName from "./InstanceNameElement.js";
import * as _feedAuthor from "./FeedAuthorLinkElement.js";
export class LocalIdentityElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  async connectedCallback() {
    const scuttlebuttHost = await window.scuttlebuttHost;
    const localId = new FeedId(scuttlebuttHost.getClientKeyPair().publicKey);
    const certBlob = new Blob([
      serializeKeyPair(
        scuttlebuttHost.getClientKeyPair(),
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
    ${localId.toString()}
    <p>This is your Scuttlebutt identity. It is stored in this browser alongside your private key.</p>
    
    <p>On the scuttleverse portal run by <ssb-instance-name></ssb-instance-name> your profile is
    <ssb-feed-author-link feed="${
      sigilToIri(localId.toString())
    }" image ></ssb-feed-author-link>
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
        <h2>Feed</h2>
        <div id="feed">
        Your feed contains all the data you generate. 
        The latest message found in your feed has sequence <span id="latestSeq"></span> and ID <span id="latestId"></span>.<br>
        As the feed is replicated by pubs and followers it is most likely backed up on the Scuttlebutt network. 
        But to be extra safe you may download it.
        <a download="feed.json" id="feedDownload" class="action">Download feed</a>
        </div>
        <div id="nofeed">
          You don't currently seem to have a feed. A feed is created as soon as you generate data, for example 
          by liking a post.
        </div>
        <h2>Peers</h2>
        Your browser client attempts to synchronize your feed with the following peers:
        <ul id="peerList">
        
        </ul>
        Synchronization depends on the peer's willingness to syndicate your feed.
        If synchronization doesn't work, you might need to add an additional peer.<br>
        <label for="additionalPeer">Add peer</label>: 
        <input id="additionalPeer" type="text" size="80"></input>
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

    const feedDownload = this.shadowRoot.getElementById("feedDownload");
    feedDownload.onclick = async () => {
      const msgs = [];
      for await (
        const msg of scuttlebuttHost.feedsAgent.getFeed(localId, {
          fromMessage: 1,
          newMessages: false,
        })
      ) {
        msgs.push(msg);
      }

      const feedBlob = new Blob([
        JSON.stringify(msgs, undefined, 2),
      ], { type: "application/json" });
      const feedURL = URL.createObjectURL(feedBlob);
      feedDownload.href = feedURL;
    };

    const peerList = this.shadowRoot.getElementById("peerList");
    const updatePeerList = () => {
      peerList.replaceChildren();
      scuttlebuttHost.peers.forEach((peer) => {
        const li = document.createElement("li");
        li.appendChild(document.createTextNode(peer));
        peerList.appendChild(li);
      });
    };
    updatePeerList();

    const additionalPeer = this.shadowRoot.getElementById("additionalPeer");
    additionalPeer.addEventListener("keypress", async (e) => {
      if (e.key === "Enter") {
        await scuttlebuttHost.peers.add(parseAddress(e.target.value));
        e.target.value = "";
        updatePeerList();
      }
    });

    const feedArea = this.shadowRoot.getElementById("feed");
    const nofeedArea = this.shadowRoot.getElementById("nofeed");
    const latestId = this.shadowRoot.getElementById("latestId");
    const latestSeq = this.shadowRoot.getElementById("latestSeq");
    feedArea.style = "display: none";
    for await (
      const msg of scuttlebuttHost.feedsAgent.getFeed(localId, {
        fromMessage: -1,
      })
    ) {
      feedArea.style = "display: block";
      nofeedArea.style = "display: none";
      latestId.textContent = msg.key;
      latestSeq.textContent = msg.value.sequence;
    }
  }
}
window.customElements.define("ssb-local-identity", LocalIdentityElement);
