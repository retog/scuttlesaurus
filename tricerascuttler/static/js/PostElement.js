import {
  handleSsbLinks,
  iriToSigil,
  mdToHtml,
  ReadStateManager,
  runQuery,
} from "./web-util.js";
import * as _feedAuthor from "./FeedAuthorLinkElement.js";
import * as _postLink from "./PostLinkElement.js";

export class PostElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    handleSsbLinks(this.shadowRoot);
    const msgUri = this.getAttribute("src");
    //sparql endpoints might not preserve order: https://github.com/acoli-repo/conll-rdf/issues/43
    runQuery(`PREFIX ssb: <ssb:ontology:>
        SELECT ?timestamp ?text ?root ?author (GROUP_CONCAT(?reply ; SEPARATOR=",") as ?replies) WHERE {
          { SELECT * WHERE {
            <${msgUri}> ssb:timestamp ?timestamp;
                        ssb:content ?content;
                        ssb:author ?author.
            ?content ssb:text ?text.
            OPTIONAL {?content ssb:root ?root}
            OPTIONAL {?reply ssb:timestamp ?replyTimestamp; ssb:content [ ssb:root <${msgUri}> ]}
          } ORDER BY ?replyTimestamp }
          } GROUP BY ?timestamp ?text ?root ?author`).then((result) => {
      const bindings = result.results.bindings;
      if (!bindings[0]) {
        this.shadowRoot.innerHTML = `Don't know anything about ${msgUri}`;
      } else {
        const text = bindings[0].text?.value;
        const timestamp = new Date(parseInt(bindings[0].timestamp?.value));
        this.shadowRoot.innerHTML = `
        <style>
        img {
          max-width: 100%;
        }
        :host {
          display: block;
          border-style: solid;
          margin: 5pt;
          padding: 5pt;
        }
        #permalink {
          text-decoration: none;
          float: right;
          height: 100%;
          margin-top: 5px;
          margin-right: 5px;
          color: #232c3d;
          font-size: 14px;
        }

        ssb-feed-author-link {
          float: right;
          background-color: white;
          border-bottom-left-radius: 10px;
          padding: 5px;
          box-shadow: -9px 7px 8px rgba(139, 138, 138, 0.1);
        }

        #actions {
          width: 100%;
          margin-top: 8px;
          background-color: #bccbe9;
        }

        #actions button {
          letter-spacing: 3px;
          border: none;
          padding: 5px;
          background-color: #bccbe9;
          color: #232c3d;
          font-size: 14px;
          cursor: pointer;
          transition: 0.5s;
          box-shadow: 0px 5px 15px rgba(0, 0, 0, .2);
        }
      </style>
      <ssb-feed-author-link feed="${
          bindings[0].author.value
        }" image ></ssb-feed-author-link>
            ${mdToHtml(text ?? "")}<br>
            <time datetime="${timestamp.toString()}">${timestamp.toLocaleString()}</time><br>
            
        ${
          bindings[0].root
            ? `In reply to <ssb-post-link href="${
              bindings[0].root.value
            }"></ssb-post-link><br>`
            : ""
        }
        ${
          bindings[0].replies.value.split(",").filter((s) => s != "").map(
            (reply) =>
              `Reply: <ssb-post-link href="${reply}"></ssb-post-link><br>`,
          ).join("")
        }
        <div id="actions">
          <a id="permalink" href="/?uri=${msgUri}">🔗</a>
        </div>`;
        const actionsArea = this.shadowRoot.getElementById("actions");
        const markAsReadButton = document.createElement("button");
        const setMarkAsReadButtonLabel = () => {
          if (ReadStateManager.isRead(msgUri)) {
            markAsReadButton.innerHTML = "Mark as unread";
          } else {
            markAsReadButton.innerHTML = "Mark as read";
          }
        };
        setMarkAsReadButtonLabel();
        markAsReadButton.onclick = () => {
          if (ReadStateManager.isRead(msgUri)) {
            ReadStateManager.markAsUnread(msgUri);
            this.classList.remove("read");
          } else {
            ReadStateManager.markAsRead(msgUri);
            this.classList.add("read");
          }
          setMarkAsReadButtonLabel();
        };
        actionsArea.append(markAsReadButton);
        const copyUriButton = document.createElement("button");
        copyUriButton.innerHTML = "Copy URI";
        copyUriButton.onclick = async () => {
          try {
            await navigator.clipboard.writeText(msgUri);
            alert("Message URI copied to clipboard");
          } catch (_error) {
            console.log(`Failed writing to clipboard: ${msgUri}`);
          }
        };
        actionsArea.append(copyUriButton);
        const copySigilButton = document.createElement("button");
        copySigilButton.innerHTML = "Copy Sigil";
        copySigilButton.onclick = async () => {
          try {
            await navigator.clipboard.writeText(iriToSigil(msgUri));
            alert("Message Sigil copied to clipboard");
          } catch (_error) {
            console.log(`Failed writing to clipboard: ${iriToSigil(msgUri)}`);
          }
        };
        actionsArea.append(copySigilButton);
      }
    });
  }
}
window.customElements.define("ssb-post", PostElement);
