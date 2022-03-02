import {
  handleSsbLinks,
  iriToSigil,
  mdToHtml,
  ReadStateManager,
  runQuery,
  sigilToIri,
} from "./web-util.js";
import * as _feedAuthor from "./FeedAuthorLinkElement.js";
import * as _postLink from "./PostLinkElement.js";

export class PostElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    handleSsbLinks(this.shadowRoot);
    this.msgUri = this.getAttribute("src");
  }

  async connectedCallback() {
    //sparql endpoints might not preserve order: https://github.com/acoli-repo/conll-rdf/issues/43
    const result = await runQuery(`PREFIX ssb: <ssb:ontology:>
        SELECT ?timestamp ?text ?root ?author (GROUP_CONCAT(?reply ; SEPARATOR=",") as ?replies) WHERE {
          { SELECT * WHERE {
            <${this.msgUri}> ssb:timestamp ?timestamp;
                        ssb:content ?content;
                        ssb:author ?author.
            ?content ssb:text ?text.
            OPTIONAL {?content ssb:root ?root}
            OPTIONAL {?reply ssb:timestamp ?replyTimestamp; ssb:content [ ssb:root <${this.msgUri}> ]}
          } ORDER BY ?replyTimestamp }
          } GROUP BY ?timestamp ?text ?root ?author`);
    const bindings = result.results.bindings;
    if (!bindings[0]) {
      this.shadowRoot.innerHTML = `Don't know anything about ${this.msgUri}`;
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
        bindings[0].replies
          ? bindings[0].replies.value.split(",").filter((s) => s != "").map(
            (reply) =>
              `Reply: <ssb-post-link href="${reply}"></ssb-post-link><br>`,
          ).join("")
          : ""
      }
        <div id="actions">
          <a id="permalink" href="/?uri=${this.msgUri}">🔗</a>
        </div>`;
      const actionsArea = this.shadowRoot.getElementById("actions");
      actionsArea.append(await this.createLikeUnlikeButton());
      const markAsReadButton = document.createElement("button");
      const setMarkAsReadButtonLabel = () => {
        if (ReadStateManager.isRead(this.msgUri)) {
          markAsReadButton.innerHTML = "Mark as unread";
        } else {
          markAsReadButton.innerHTML = "Mark as read";
        }
      };
      setMarkAsReadButtonLabel();
      markAsReadButton.onclick = () => {
        if (ReadStateManager.isRead(this.msgUri)) {
          ReadStateManager.markAsUnread(this.msgUri);
          this.classList.remove("read");
        } else {
          ReadStateManager.markAsRead(this.msgUri);
          this.classList.add("read");
        }
        setMarkAsReadButtonLabel();
      };
      actionsArea.append(markAsReadButton);
      const copyUriButton = document.createElement("button");
      copyUriButton.innerHTML = "Copy URI";
      copyUriButton.onclick = async () => {
        try {
          await navigator.clipboard.writeText(this.msgUri);
          alert("Message URI copied to clipboard");
        } catch (_error) {
          console.log(`Failed writing to clipboard: ${this.msgUri}`);
        }
      };
      actionsArea.append(copyUriButton);
      const copySigilButton = document.createElement("button");
      copySigilButton.innerHTML = "Copy Sigil";
      copySigilButton.onclick = async () => {
        try {
          await navigator.clipboard.writeText(iriToSigil(this.msgUri));
          alert("Message Sigil copied to clipboard");
        } catch (_error) {
          console.log(
            `Failed writing to clipboard: ${iriToSigil(this.msgUri)}`,
          );
        }
      };
      actionsArea.append(copySigilButton);
    }
  }

  async createLikeUnlikeButton() {
    const scuttlebuttHost = await window.scuttlebuttHost;
    const localId = sigilToIri(scuttlebuttHost.identity.toString());
    let isLiked =
      (await runQuery(`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    PREFIX ssb: <ssb:ontology:>
    
    ASK {
      {
        SELECT (MAX(?seq) AS ?maxSeq) WHERE {
            {
              ?msg rdf:type ssb:Message;
                    ssb:author <${localId}>;
                    ssb:content ?content;
                    ssb:seq ?seq.
              ?content rdf:type ssb:Vote;
                    ssb:link <${this.msgUri}>.
            } UNION {
              BIND (0 AS ?seq)
            }
          }
      }
      ?msg ssb:author <${localId}>;
        ssb:content ?content;
        ssb:seq ?maxSeq.
      ?content 
        rdf:value "1"^^<http://www.w3.org/2001/XMLSchema#integer>.
    } 
`)).boolean;
    const button = document.createElement("button");
    const setLabel = () => button.innerHTML = isLiked ? "Unlike" : "Like";
    setLabel();
    button.onclick = async () => {
      const message = {
        type: "vote",
        vote: {
          link: iriToSigil(this.msgUri),
        },
      };
      if (!isLiked) {
        message.vote.value = 1;
        message.vote.expression = "Like";
      } else {
        message.vote.value = 0;
        message.vote.expression = "Unlike";
      }
      await scuttlebuttHost.publish(message);
      isLiked = !isLiked;
      setLabel();
    };
    return button;
  }
}
window.customElements.define("ssb-post", PostElement);
