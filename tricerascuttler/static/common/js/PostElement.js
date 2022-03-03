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
        <link rel="stylesheet" href="./reset.css">
        <style>
        :host {
          border: 1px solid gray;
          border-radius: 0.6rem;
          display: block;
        }

        img {
          display: block;
          max-width: 100%;
        }

        ssb-feed-author-link {
          display: block;
        }

        .content {
          border-top: 1px solid #eeeeee;
          font-size: 1.2rem;
          line-height: 1.4rem;
          padding: 0.4rem 0.4rem 0.4rem 2.8rem;
        }

        .content a {
          color: darkblue;
        }

        .meta {
          border-top: 1px solid #eeeeee;
          color: darkgrey;
          font-size: 0.8rem;
          padding: 0.2rem 0.2rem 0.2rem 2.8rem;
        }

        .content:empty,
        .meta:empty {
          display: none;
        }

        #actions {
          border-top: 1px solid #eeeeee;
          display: flex;
          gap: 0.2rem;
          padding-left: 2.8rem;
        }

        #actions > * {
          cursor: pointer;
          font-size: 0.8rem;
          padding: 0.2rem;
        }

        #actions > *:hover {
          background-color: #eeeeee;
        }
      </style>
      <ssb-feed-author-link feed="${
        bindings[0].author.value
      }" image ></ssb-feed-author-link>
      <div class="content">${mdToHtml(text ?? "")}</div>
      <div class="meta">
        <time datetime="${timestamp.toString()}">${timestamp.toLocaleString()}</time>
      </div>
      <div class="meta">${
        bindings[0].root
          ? `In reply to <ssb-post-link href="${
            bindings[0].root.value
          }"></ssb-post-link>`
          : ""
      }</div>
      <div class="meta">${
        bindings[0].replies
          ? bindings[0].replies.value.split(",").filter((s) => s != "").map(
            (reply) =>
              `Reply: <ssb-post-link href="${reply}"></ssb-post-link><br>`,
          ).join("")
          : ""
      }
        <div id="actions">
          <a id="permalink" href="/?uri=${this.msgUri}">Permalink</a>
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
