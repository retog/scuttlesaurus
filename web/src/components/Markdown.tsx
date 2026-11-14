/**
 * Sanitized Markdown for articles. `nostr:` references become in-app links,
 * images load lazily, external links open in a new tab.
 *
 * @module
 */
import DOMPurify from "dompurify";
import { Marked } from "marked";
import { useMemo } from "preact/hooks";
import { handleLinkClick } from "../lib/router.tsx";
import { routeForNip19, shortNpub } from "../lib/nostr.ts";

const NOSTR_URI = /^nostr:(?:npub|nprofile|note|nevent|naddr)1[a-z0-9]+/;

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

const marked = new Marked({ gfm: true, breaks: false });

marked.use({
  extensions: [{
    name: "nostrUri",
    level: "inline",
    start: (src: string) => src.indexOf("nostr:"),
    tokenizer(src: string) {
      const match = NOSTR_URI.exec(src);
      return match
        ? { type: "nostrUri", raw: match[0], uri: match[0] }
        : undefined;
    },
    renderer(token) {
      const uri = (token as unknown as { uri: string }).uri;
      const href = routeForNip19(uri);
      if (!href) return escapeHtml(uri);
      const ref = uri.slice(6);
      const label = ref.startsWith("npub") || ref.startsWith("nprofile")
        ? "@" + shortNpub(ref)
        : ref.slice(0, 12) + "…";
      return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
    },
  }],
  walkTokens(token) {
    if (token.type === "link" && token.href.startsWith("nostr:")) {
      token.href = routeForNip19(token.href) ?? "#";
    }
  },
});

let hooked = false;
function installHooks(): void {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node instanceof HTMLImageElement) {
      node.setAttribute("loading", "lazy");
      node.setAttribute("decoding", "async");
    }
    if (node instanceof HTMLAnchorElement) {
      const href = node.getAttribute("href") ?? "";
      if (/^https?:\/\//i.test(href)) {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer nofollow");
      }
    }
  });
}

/** Render Markdown to sanitized HTML (exported for tests and previews). */
export function renderMarkdown(source: string): string {
  installHooks();
  const html = marked.parse(source, { async: false });
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ["target"],
    FORBID_ATTR: ["style"],
    FORBID_TAGS: ["style", "form", "input", "button"],
  });
}

/** Props of {@link Markdown}. */
export interface MarkdownProps {
  source: string;
  class?: string;
}

/** Long-form reading typography (`.prose`) around sanitized Markdown. */
export function Markdown({ source, class: className }: MarkdownProps) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return (
    <div
      class={`prose${className ? " " + className : ""}`}
      onClick={handleLinkClick}
      // deno-lint-ignore react-no-danger
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
