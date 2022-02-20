import { runQuery } from "./web-util.js";

export class HostPeersElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  async connectedCallback() {
    this.shadowRoot.innerHTML = `
    <style>
    .hidden {
      display: none;
    }
    </style>
    <ul id="peerList">

    </ul>
    Add peer: <input id="newPeer" type="text" size="90" />
    <ul id="potentialPeers">

    </ul>
    <button id="addAllButton" class="hidden">Add all</button>
    <h2 id="excludedPeersHeading" class="hidden">Exluded Peers</h2>
    <ul id="excludedPeerList">

    </ul>
    `;
    const peerList = this.shadowRoot.getElementById("peerList");
    const newPeer = this.shadowRoot.getElementById("newPeer");
    const potentialPeers = this.shadowRoot.getElementById("potentialPeers");
    const addAllButton = this.shadowRoot.getElementById("addAllButton");
    const excludedPeersHeading = this.shadowRoot.getElementById(
      "excludedPeersHeading",
    );
    const excludedPeerList = this.shadowRoot.getElementById("excludedPeerList");

    const excludedPeers = await (await fetch("./excluded-peers")).json();
    for (const peer of excludedPeers) {
      excludedPeersHeading.classList.remove("hidden");
      const li = document.createElement("li");
      li.appendChild(document.createTextNode(peer));
      excludedPeerList.appendChild(li);
    }
    async function addPeer(peer) {
      await fetch("./peers", {
        "headers": {
          "Accept": "application/json,*/*;q=0.9",
          "Content-Type": "application/json",
        },
        "body": JSON.stringify({ "address": peer }),
        "method": "POST",
      });
      populateList();
    }
    async function removePeer(peer) {
      await fetch("./peers", {
        "headers": {
          "Accept": "application/json,*/*;q=0.9",
          "Content-Type": "application/json",
        },
        "body": JSON.stringify({ "address": peer, "action": "remove" }),
        "method": "POST",
      });
      populateList();
    }
    async function populateList() {
      const response = await fetch("./peers");
      const peers = await response.json();
      peerList.replaceChildren();
      peers.forEach((peer) => {
        const li = document.createElement("li");
        li.appendChild(document.createTextNode(peer));
        const button = document.createElement("button");
        li.appendChild(button);
        button.innerHTML = "Remove";
        peerList.appendChild(li);
        button.addEventListener("click", () => {
          removePeer(peer);
        });
      });
      potentialPeers.replaceChildren();
      for await (const pub of pubs()) {
        if (
          (peers.indexOf(pub) === -1) && (excludedPeers.indexOf(pub) === -1)
        ) {
          addAllButton.classList.remove("hidden");
          const li = document.createElement("li");
          li.appendChild(document.createTextNode(pub));
          const button = document.createElement("button");
          li.appendChild(button);
          button.innerHTML = "Add";
          button.className = "add";
          potentialPeers.appendChild(li);
          button.addEventListener("click", () => {
            addPeer(pub);
          });
        }
      }
      return peers;
    }
    async function* pubs() {
      const queryResults = await runQuery(
        `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
          PREFIX ssb: <ssb:ontology:>

          SELECT DISTINCT ?address WHERE {
              ?pub rdf:type ssb:Pub;
                  ssb:address ?address.
          }`,
      );
      for (const binding of queryResults.results.bindings) {
        yield binding.address.value;
      }
    }
    newPeer.addEventListener("keypress", async (e) => {
      if (e.key === "Enter") {
        await addPeer(e.target.value);
        e.target.value = "";
      }
    });
    /*await*/ populateList();

    addAllButton.addEventListener("click", () => {
      this.shadowRoot.querySelectorAll(".add").forEach((b) => b.click());
    });
  }
}
window.customElements.define("ssb-host-peers", HostPeersElement);
