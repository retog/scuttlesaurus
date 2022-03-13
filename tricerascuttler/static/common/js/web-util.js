import * as _mark from "./ext/commonmark.js";
const mdReader = new commonmark.Parser();
const mdWriter = new commonmark.HtmlRenderer();

export function mdToHtml(md) {
  function replaceSigils(ast) {
    const walker = ast.walker();
    let event, node;

    while ((event = walker.next())) {
      node = event.node;
      if (event.entering) {
        if (node.type === "link") {
          node.destination = sigilToIri(node.destination);
        }
        if (node.type === "image") {
          node.destination = sigilToIri(node.destination).replace(
            "ssb:blob/",
            "./blob/",
          );
        }
      }
    }
    return ast;
  }
  return mdWriter.render(replaceSigils(mdReader.parse(md)));
}

export function handleSsbLinks(element) {
  element.addEventListener(`click`, (e) => {
    const origin = e.target.closest(`a`);

    if (origin) {
      if (origin.href.startsWith("ssb:")) {
        console.log(`Changing ${origin.href} to local`);
        origin.href = window.location.origin + "/?uri=" +
          origin.href.replace("ssb://", "ssb:");
        window.location = origin.href;
        return false;
      }
    }
  });
}

export function sigilToIri(sigil) {
  const hashPart = sigil.substring(1, sigil.lastIndexOf("."));
  const safeHashPart = hashPart.replaceAll("/", "_").replaceAll("+", "-");
  switch (sigil[0]) {
    case "@":
      return "ssb:feed/ed25519/" + safeHashPart;
    case "&":
      return "ssb:blob/sha256/" + safeHashPart;
    case "%":
      return "ssb:message/sha256/" + safeHashPart;
    default:
      //let's hope it's an iri
      return sigil;
  }
}
const sigilPrefix = {
  feed: "@",
  blob: "&",
  message: "%",
};
export function iriToSigil(iri) {
  const postPrefix = iri.substring(4);
  const [type, cypher, safeHashPart] = postPrefix.split("/");
  const hashPart = safeHashPart.replaceAll("_", "/").replaceAll("-", "+");
  return `${sigilPrefix[type]}${hashPart}.${cypher}`;
}

export async function mainIdentity() {
  const response = await fetch("/main-identity");
  const whoami = await response.json();
  return sigilToIri(whoami.feedId);
}

export async function runQuery(query) {
  const response = await fetch("/query?" + new URLSearchParams({ query }), {
    "headers": {
      "Accept": "application/sparql-results+json,*/*;q=0.9",
    },
    "method": "GET",
  });
  if (response.status >= 300) {
    throw new Error(response.statusText);
  }

  return await response.json();
}

export const ReadStateManager = {
  getReadMessages() {
    return localStorage.readMessages
      ? JSON.parse(localStorage.readMessages)
      : [];
  },

  setReadMessages(messages) {
    localStorage.readMessages = JSON.stringify(messages);
  },

  markAsRead(msgUri) {
    const messages = this.getReadMessages();
    messages.push(msgUri);
    this.setReadMessages(messages);
  },
  markAsUnread(msgUri) {
    const messages = this.getReadMessages();
    messages.splice(messages.indexOf(msgUri), 1);
    this.setReadMessages(messages);
  },
  isRead(msgUri) {
    return this.getReadMessages().indexOf(msgUri) > -1;
  },
};

export async function getBrowserUser() {
  while (!window.scuttlebuttHost) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const scuttlebuttHost = await window.scuttlebuttHost;
  const localId = sigilToIri(scuttlebuttHost.identity.toString());
  return localId;
}
