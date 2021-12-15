import * as _FeedAuth from "./FeedAuthorElement.js";
import * as _FeedAuthList from "./FeedAuthorListElement.js";
import * as _PostsList from "./PostListElement.js";

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
      grid-template-columns: 1fr 1fr 1fr 1fr 1fr 1fr 1fr;
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
    <h1>Profile</h1>
    <ssb-feed-author src="${feedUri}"></ssb-feed-author>
    <div class="wrapper">
    <div class="buttonWrapper">
      <button class="tab-button active" style="border-top-left-radius: 10px;" data-id="posts">Posts</button>
      <button class="tab-button" data-id="followees">Following</button>
      <button class="tab-button" data-id="blockees">Blocking</button>
      <button class="tab-button" data-id="followers">Followers</button>
      <button class="tab-button" data-id="blockers">Blocked by</button>
      <button class="tab-button" data-id="likes">Likes most</button>
      <button class="tab-button" style="border-top-right-radius: 10px;" data-id="likers">Top likers</button>
    </div>
    <div class="contentWrapper">
    <p class="content active" id="posts">
    <ssb-post-list query="PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
        PREFIX ssb: <ssb:ontology:>
        SELECT ?post {
            ?post ssb:seq ?seq;
                 ssb:author <${feedUri}>;
                 ssb:content ?content.
            ?content rdf:type ssb:Post.
        } ORDER BY DESC(?seq)"></ssb-post-list>
        </p>
    <p class="content" id="followees">
        <ssb-feed-author-list query="PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
        PREFIX ssb: <ssb:ontology:>
      
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
      <p class="content" id="blockees">
        <ssb-feed-author-list query="PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
        PREFIX ssb: <ssb:ontology:>
      
      SELECT ?feed {
        ?msg ssb:author <${feedUri}>;
              ssb:content ?content;
              ssb:seq ?finalSeq.
          ?content ssb:blocking true.
        {
          SELECT ?feed (MAX(?seq) as ?finalSeq)   {
            ?msg ssb:author <${feedUri}>;
                ssb:content ?content;
                ssb:seq ?seq.
            ?content rdf:type ssb:Contact;
                ssb:contact ?feed;
                ssb:blocking ?blocking.
          } GROUP BY ?feed
        
        }
      } "></ssb-feed-author-list>
      </p>
      <p class="content" id="followers">
        <ssb-feed-author-list query="PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
        PREFIX ssb: <ssb:ontology:>
          
          SELECT ?feed {
            ?msg ssb:author ?feed;
                   ssb:content ?content;
                   ssb:seq ?finalSeq.
              ?content ssb:following true.
            {
              SELECT ?feed (MAX(?seq) as ?finalSeq)   {
                ?msg ssb:author ?feed;
                     ssb:content ?content;
                     ssb:seq ?seq.
                ?content rdf:type ssb:Contact;
                     ssb:contact <${feedUri}>;
                     ssb:following ?following.
              } GROUP BY ?feed
          }
        }"></ssb-feed-author-list>
      </p>
      <p class="content" id="blockers">
        <ssb-feed-author-list query="PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
        PREFIX ssb: <ssb:ontology:>
          
          SELECT ?feed {
            ?msg ssb:author ?feed;
                   ssb:content ?content;
                   ssb:seq ?finalSeq.
              ?content ssb:blocking true.
            {
              SELECT ?feed (MAX(?seq) as ?finalSeq)   {
                ?msg ssb:author ?feed;
                     ssb:content ?content;
                     ssb:seq ?seq.
                ?content rdf:type ssb:Contact;
                     ssb:contact <${feedUri}>;
                     ssb:blocking ?blocking.
              } GROUP BY ?feed
          }
        }"></ssb-feed-author-list>
      </p>
      <p class="content" id="likes">
        <ssb-feed-author-list query="PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
        PREFIX ssb: <ssb:ontology:>
        
        SELECT ?feed (COUNT(DISTINCT ?msg) AS ?vcount) WHERE {
          ?msgVote ssb:content [
              rdf:type ssb:Vote;
              ssb:link ?msg;
              ];
              ssb:author <${feedUri}>.
          ?msg rdf:type ssb:Message;
          ssb:author ?feed.
        
        } GROUP BY ?feed ORDER BY DESC(?vcount) LIMIT 20"></ssb-feed-author-list>
      </p>
      <p class="content" id="likers">
        <ssb-feed-author-list query="PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
        PREFIX ssb: <ssb:ontology:>
        
        SELECT ?feed (COUNT(DISTINCT ?msg) AS ?vcount) WHERE {
          ?msgVote ssb:content [
              rdf:type ssb:Vote;
              ssb:link ?msg;
              ];
              ssb:author ?feed.
          ?msg rdf:type ssb:Message;
          ssb:author <${feedUri}>.
        
        } GROUP BY ?feed ORDER BY DESC(?vcount) LIMIT 20"></ssb-feed-author-list>
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
  }
}
window.customElements.define("ssb-profile", ProfileElement);
