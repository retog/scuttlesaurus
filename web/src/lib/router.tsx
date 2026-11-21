/**
 * A small History-API router.
 *
 * The route table ({@link ROUTES}) is the single list of paths of the client;
 * `web/src/routes.ts` maps each route name to its view. Use {@link Link} for
 * in-app links, {@link navigate} for programmatic navigation and
 * {@link route} (or {@link useRoute}) to read where we are.
 *
 * Scroll positions are restored on back/forward; pushing a new entry scrolls
 * to the top.
 *
 * @module
 */
import { computed, signal } from "@preact/signals";
import type { AnchorHTMLAttributes, ComponentChildren } from "preact";

/** Names of all routes. */
export type RouteName =
  | "home"
  | "note"
  | "reads"
  | "article"
  | "write"
  | "profile"
  | "notifications"
  | "search"
  | "network"
  | "settings"
  | "gallery"
  | "notFound";

/**
 * The route table. Patterns use `:name` for a parameter and `:name?` for an
 * optional one. The first match wins.
 */
export const ROUTES: readonly { name: RouteName; pattern: string }[] = [
  { name: "home", pattern: "/" },
  { name: "note", pattern: "/n/:id" },
  { name: "reads", pattern: "/reads" },
  { name: "article", pattern: "/a/:naddr" },
  { name: "write", pattern: "/write/:naddr?" },
  { name: "profile", pattern: "/p/:id" },
  { name: "notifications", pattern: "/notifications" },
  { name: "search", pattern: "/search" },
  { name: "network", pattern: "/network" },
  { name: "settings", pattern: "/settings" },
  { name: "gallery", pattern: "/dev/gallery" },
];

/** The current location, resolved against the route table. */
export interface Route {
  name: RouteName;
  /** Decoded path parameters; optional ones that are absent are missing. */
  params: Record<string, string>;
  pathname: string;
  /** Parsed query string, e.g. `route.value.query.get("q")`. */
  query: URLSearchParams;
  hash: string;
}

/** Match `pathname` against a pattern; returns params or `null`. */
export function matchPattern(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const want = pattern.split("/").filter(Boolean);
  const have = pathname.split("/").filter(Boolean);
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const part = want[i];
    if (part.startsWith(":")) {
      const optional = part.endsWith("?");
      const key = part.slice(1, optional ? -1 : undefined);
      if (have[i] === undefined) {
        if (optional) continue;
        return null;
      }
      try {
        params[key] = decodeURIComponent(have[i]);
      } catch {
        params[key] = have[i];
      }
    } else if (part !== have[i]) {
      return null;
    }
  }
  return have.length > want.length ? null : params;
}

function resolve(url: URL): Route {
  for (const { name, pattern } of ROUTES) {
    const params = matchPattern(pattern, url.pathname);
    if (params) {
      return {
        name,
        params,
        pathname: url.pathname,
        query: url.searchParams,
        hash: url.hash,
      };
    }
  }
  return {
    name: "notFound",
    params: {},
    pathname: url.pathname,
    query: url.searchParams,
    hash: url.hash,
  };
}

const location_ = signal(new URL(globalThis.location.href));

/** The current route. Reading `.value` in a component subscribes to it. */
export const route = computed<Route>(() => resolve(location_.value));

/** Hook form of {@link route}. */
export function useRoute(): Route {
  return route.value;
}

// --- scroll restoration -----------------------------------------------------

history.scrollRestoration = "manual";
const scrollPositions = new Map<string, number>();
let entryKey = (history.state as { key?: string } | null)?.key ?? newKey();

function newKey(): string {
  return Math.random().toString(36).slice(2);
}

function remember(): void {
  scrollPositions.set(entryKey, globalThis.scrollY);
}

function restore(top: number): void {
  // Wait for the new view to render before scrolling.
  requestAnimationFrame(() => requestAnimationFrame(() => scrollTo(0, top)));
}

history.replaceState({ key: entryKey }, "");

addEventListener("popstate", (event) => {
  remember();
  entryKey = (event.state as { key?: string } | null)?.key ?? newKey();
  location_.value = new URL(globalThis.location.href);
  restore(scrollPositions.get(entryKey) ?? 0);
});

/** Navigate to an in-app path (with optional query and hash). */
export function navigate(
  to: string,
  options: { replace?: boolean } = {},
): void {
  const url = new URL(to, globalThis.location.href);
  if (url.origin !== globalThis.location.origin) {
    globalThis.location.assign(url.href);
    return;
  }
  const same = url.href === globalThis.location.href;
  remember();
  entryKey = newKey();
  if (options.replace || same) {
    history.replaceState({ key: entryKey }, "", url);
  } else {
    history.pushState({ key: entryKey }, "", url);
  }
  location_.value = url;
  restore(0);
}

/**
 * Click handler that turns clicks on same-origin anchors inside a container
 * into in-app navigation. Used by {@link Link} and by components that render
 * HTML (Markdown).
 */
export function handleLinkClick(event: MouseEvent): void {
  if (
    event.defaultPrevented || event.button !== 0 || event.metaKey ||
    event.ctrlKey || event.shiftKey || event.altKey
  ) return;
  const anchor = (event.target as Element | null)?.closest?.("a");
  if (
    !anchor || anchor.target === "_blank" || anchor.hasAttribute("download")
  ) {
    return;
  }
  const href = anchor.getAttribute("href");
  if (!href || href.startsWith("#")) return;
  const url = new URL(href, globalThis.location.href);
  if (url.origin !== globalThis.location.origin) return;
  event.preventDefault();
  navigate(url.pathname + url.search + url.hash);
}

/** Props of {@link Link}: an anchor with `to` instead of `href`. */
export interface LinkProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "role"> {
  to: string;
  children?: ComponentChildren;
}

/** An in-app link: normal anchor semantics, navigation without reload. */
export function Link({ to, children, onClick, ...rest }: LinkProps) {
  return (
    <a
      {...rest}
      href={to}
      onClick={(event) => {
        const native = event as unknown as MouseEvent;
        (onClick as unknown as ((e: MouseEvent) => void) | undefined)?.(native);
        handleLinkClick(native);
      }}
    >
      {children}
    </a>
  );
}

/**
 * Whether `pathname` is at or below `base` (`/` only matches exactly).
 * Handy for `aria-current` on navigation items.
 */
export function isActive(base: string, pathname: string): boolean {
  return base === "/"
    ? pathname === "/"
    : pathname === base || pathname.startsWith(base + "/");
}
