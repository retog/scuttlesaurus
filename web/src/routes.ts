/**
 * Which view renders which route. The paths themselves live in
 * `lib/router.tsx` (`ROUTES`).
 *
 * To add a view: add the route (name and pattern) to `ROUTES`, create
 * `views/<Name>.tsx` with a default-exported component, and map it here. The
 * `satisfies` clause makes a missing entry a compile error.
 *
 * @module
 */
import type { ComponentType } from "preact";
import type { RouteName } from "./lib/router.tsx";
import Article from "./views/Article.tsx";
import Gallery from "./views/Gallery.tsx";
import Home from "./views/Home.tsx";
import Network from "./views/Network.tsx";
import Note from "./views/Note.tsx";
import NotFound from "./views/NotFound.tsx";
import Notifications from "./views/Notifications.tsx";
import Profile from "./views/Profile.tsx";
import Reads from "./views/Reads.tsx";
import Search from "./views/Search.tsx";
import Settings from "./views/Settings.tsx";
import Share from "./views/Share.tsx";
import Write from "./views/Write.tsx";

/** The view component for each route name. */
export const VIEWS = {
  home: Home,
  note: Note,
  reads: Reads,
  article: Article,
  write: Write,
  profile: Profile,
  notifications: Notifications,
  search: Search,
  network: Network,
  settings: Settings,
  share: Share,
  gallery: Gallery,
  notFound: NotFound,
} satisfies Record<RouteName, ComponentType>;
