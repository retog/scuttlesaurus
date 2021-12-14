import * as _FeedAuth from "./FeedAuthorElement.js";
import * as _FeedAuthList from "./FeedAuthorListElement.js";

export class ProfileElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });

    const feedUri = this.getAttribute("src");

    this.shadowRoot.innerHTML = `
    <style>
    .wrapper {
      width: 100%;
      margin: auto;
      background-color: white;
      border-radius: 10px;
      box-shadow: 0px 5px 15px rgba(0, 0, 0, .1);
    }
    
    .buttonWrapper {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
    }
    
    button {
      letter-spacing: 3px;
      border: none;
      padding: 10px;
      background-color: #bccbe9;
      color: #232c3d;
      font-size: 18px;
      cursor: pointer;
      transition: 0.5s;
    }
    
    button:hover {
      background-color: #d5e3ff;
    }
    
    button.active {
      background-color: white;
    }
    
    .active {
      background-color: white;
    }
    
    p {
      text-align: left;
      padding: 10px;
    }
    
    .content {
      display: none;
      padding: 10px 20px;
    }
    
    .content.active {
      display: block;
    }
    </style>
    <h1>profile</h1>
    <ssb-feed-author src="${feedUri}"></ssb-feed-author>
    <div class="wrapper">
    <div class="buttonWrapper">
      <button class="tab-button active" style="border-top-left-radius: 10px;" data-id="followees">Following</button>
      <button class="tab-button" data-id="blockees">Blocking</button>
      <button class="tab-button" style="border-top-right-radius: 10px;" data-id="contact">Details</button>
    </div>
    <div class="contentWrapper">
      <p class="content active" id="followees">
        <ssb-feed-author-list query="PREFIX rdf: &lt;http://www.w3.org/1999/02/22-rdf-syntax-ns#>
        PREFIX ssb: &lt;ssb:ontology:>
      
      SELECT ?feed {
        ?msg ssb:author &lt;${feedUri}>;
              ssb:content ?content;
              ssb:seq ?finalSeq.
          ?content ssb:following true.
        {
          SELECT ?feed (MAX(?seq) as ?finalSeq)   {
            ?msg ssb:author &lt;${feedUri}>;
                ssb:content ?content;
                ssb:seq ?seq.
            ?content rdf:type ssb:Contact;
                ssb:contact ?feed;
                ssb:following ?following.
          } GROUP BY ?feed
        
        }
      } "></ssb-feed-author-list>
      </p>
      <p class="content active" id="blockees">
        <ssb-feed-author-list query="PREFIX rdf: &lt;http://www.w3.org/1999/02/22-rdf-syntax-ns#>
        PREFIX ssb: &lt;ssb:ontology:>
      
      SELECT ?feed {
        ?msg ssb:author &lt;${feedUri}>;
              ssb:content ?content;
              ssb:seq ?finalSeq.
          ?content ssb:blocking true.
        {
          SELECT ?feed (MAX(?seq) as ?finalSeq)   {
            ?msg ssb:author &lt;${feedUri}>;
                ssb:content ?content;
                ssb:seq ?seq.
            ?content rdf:type ssb:Contact;
                ssb:contact ?feed;
                ssb:blocking ?blocking.
          } GROUP BY ?feed
        
        }
      } "></ssb-feed-author-list>
      </p>
      
    </div>
  </div>


  `;
    const tabs = this.shadowRoot.querySelector(".wrapper");
    const tabButton = this.shadowRoot.querySelectorAll(".tab-button");
    const contents = this.shadowRoot.querySelectorAll(".content");

    tabs.onclick = (e) => {
      const id = e.target.dataset.id;
      if (id) {
        tabButton.forEach((btn) => {
          btn.classList.remove("active");
        });
        e.target.classList.add("active");

        contents.forEach((content) => {
          content.classList.remove("active");
        });
        const element = this.shadowRoot.getElementById(id);
        element.classList.add("active");
      }
    };

    I;
  }
}
window.customElements.define("ssb-profile", ProfileElement);
