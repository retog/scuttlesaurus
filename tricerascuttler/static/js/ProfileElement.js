import * as _FeedAuth from "./FeedAuthorElement.js";
import * as _FeedAuthList from "./FeedAuthorListElement.js";
import * as _PostsList from "./PostListElement.js";
import * as _Tabs from "./TabsElement.js";

export class ProfileElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });

    const feedUri = this.getAttribute("src");

    this.shadowRoot.innerHTML = `
    <style>
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
    <ssb-tabs>
    <ssb-tab label="Posts" active>
      <template>
        <ssb-post-list loadSize="10" query="PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
            PREFIX ssb: <ssb:ontology:>
            SELECT ?post {
                ?post ssb:seq ?seq;
                    ssb:author <${feedUri}>;
                    ssb:content ?content.
                ?content rdf:type ssb:Post.
            } ORDER BY DESC(?seq)"></ssb-post-list>
      </template>
    </ssb-tab>
    <ssb-tab label="Following">
      <template>
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
          OPTIONAL {
            SELECT ?feed (MAX(?seq) AS ?latestLike) WHERE {
                 ?msgVote ssb:content [
                     rdf:type ssb:Vote;
                     ssb:link ?msg;
                     ];
                     ssb:author &lt;${feedUri}>;
                     ssb:seq ?seq.
                 ?msg rdf:type ssb:Message;
                 ssb:author ?feed.
               
               } GROUP BY ?feed
         }
       } ORDER BY DESC(?latestLike) "></ssb-feed-author-list>
      </template>
    </ssb-tab>
    <ssb-tab label="Blocking">
      <template>
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
      </template>
    </ssb-tab>
    <ssb-tab label="Followers">
      <template>
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
      </template>
    </ssb-tab>
    <ssb-tab label="Blockers">
      <template>
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
          </template>
    </ssb-tab>
    <ssb-tab label="Likes most">
      <template>
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
      </template>
    </ssb-tab>
    <ssb-tab label="Top likers">
      <template>
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
      </template>
    </ssb-tab>
  `;
  }
}
window.customElements.define("ssb-profile", ProfileElement);
