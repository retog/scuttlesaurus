import { getBrowserUser } from "./web-util.js";
import { PostListElement } from "./PostListElement.js";
import { mainIdentity } from "./web-util.js";
import { getDescription } from "./FeedAuthorElement.js";

export class ReaderElement extends PostListElement {
  constructor() {
    super();
  }

  async connectedCallback() {
    const portalHost = await mainIdentity();
    const { name: portalHostName } = await getDescription(portalHost);
    const browserUser = await getBrowserUser();
    const { name: browserUserName } = await getDescription(browserUser);
    const filterArea = this.shadowRoot.getElementById("filter");
    const socialDiv = document.createElement("div");
    socialDiv.innerHTML = `<div>
      <input type="checkbox" id="portalHost" name="portalHost"
            checked>
      <label for="portalHost">Posts by ${portalHostName}</label>
      <input type="checkbox" id="portalHostFollowees" name="portalHostFollowees"
            checked>
      <label for="portalHostFollowees">Feeds followed by ${portalHostName}</label>
      <input type="checkbox" id="browserUser" name="browserUser"
            checked>
      <label for="browserUser">Posts by ${browserUserName}</label>
      <input type="checkbox" id="browserUserFollowees" name="browserUserFollowees"
            checked>
      <label for="browserUserFollowees">Feeds followed by ${browserUserName}</label>
    </div>`;
    filterArea.insertBefore(socialDiv, filterArea.firstChild);
    const showArticles = async () => {
      const contentDiv = this.shadowRoot.getElementById("content");
      contentDiv.replaceChildren();
      const unionClauses = [];
      if (this.shadowRoot.getElementById("portalHost").checked) {
        unionClauses.push(`?post ssb:author <${portalHost}>.`)
      }
      if (this.shadowRoot.getElementById("browserUser").checked) {
        unionClauses.push(`?post ssb:author <${browserUser}>.`)
      }
      if (this.shadowRoot.getElementById("portalHostFollowees").checked) {
        unionClauses.push(`
          <${portalHost}> ssbx:follows ?portalHostFollowee.
          ?post ssb:author ?portalHostFollowee.`
        )
      }
      if (this.shadowRoot.getElementById("browserUserFollowees").checked) {
        unionClauses.push(`
        <${browserUser}> ssbx:follows ?browserUserFollowee.
        ?post ssb:author ?browserUserFollowee.`
        )
      }
      this.query = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
        PREFIX ssb: <ssb:ontology:>
        PREFIX ssbx: <ssb:ontology:derivatives:>
        SELECT ?post {
            ?post ssb:timestamp ?timestamp;
                ssb:content ?content.
            ?content rdf:type ssb:Post.
            ${unionClauses.map(clause => `
            {
              ${clause}
            }
            `).join(" UNION ")}
        } ORDER BY DESC(?timestamp)`;
      await super.connectedCallback();
    };
    socialDiv.addEventListener("click", (e) => {
      if (e.target.type === "checkbox") {
        showArticles();
      }
      console.log("click", e.target.type);
    });
    showArticles();
  }
}
window.customElements.define("ssb-reader", ReaderElement);
