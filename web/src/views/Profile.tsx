/**
 * The Profile view (`/p/:id`, with an npub, nprofile or hex key): a header
 * with the person's standing in the node's social graph, then their notes,
 * replies, articles, follows and followers, one tab at a time. The tab is in
 * the URL (`?tab=`), and defaults to notes.
 *
 * A key the node knows nothing about gets the header and an explanation of
 * the habitat instead of empty tabs. An id that is not a key gets "No such
 * person".
 *
 * @module
 */
import { User } from "lucide-preact";
import { useEffect } from "preact/hooks";
import { ArticleList } from "../components/ArticleList.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { NoteFeed } from "../components/NoteFeed.tsx";
import { PeopleList } from "../components/PeopleList.tsx";
import {
  ProfileHeader,
  type ProfileTab,
} from "../components/ProfileHeader.tsx";
import { Tabs } from "../components/Tabs.tsx";
import { fetchArticles } from "../lib/articles.ts";
import { fetchAuthorNotes } from "../lib/feed.ts";
import { useAsync, useDocumentTitle } from "../lib/hooks.ts";
import { distanceOf, isOwner, status } from "../lib/node.ts";
import { parsePubkey } from "../lib/nostr.ts";
import {
  fetchFollowedBy,
  fetchFollowedPeople,
  fetchFollowerPeople,
  fetchProfileStats,
  hasProfileFields,
  loadViewerFollows,
} from "../lib/people.ts";
import { displayNameOf, useProfile } from "../lib/profiles.ts";
import { navigate, useRoute } from "../lib/router.tsx";
import { session } from "../lib/session.ts";

const TABS: readonly { value: ProfileTab; label: string }[] = [
  { value: "notes", label: "Notes" },
  { value: "replies", label: "With replies" },
  { value: "articles", label: "Articles" },
  { value: "following", label: "Following" },
  { value: "followers", label: "Followers" },
];

function tabOf(raw: string | null): ProfileTab {
  const found = TABS.find((t) => t.value === raw);
  return found ? found.value : "notes";
}

function NoSuchPerson({ id }: { id: string | undefined }) {
  useDocumentTitle("Profile");
  const shown = (id ?? "").slice(0, 80);
  return (
    <div class="page profile-page">
      <EmptyState title="No such person" icon={<User size={36} />}>
        {shown
          ? <>“{shown}” is not an npub, an nprofile or a public key.</>
          : "There is no key in this address."}
      </EmptyState>
    </div>
  );
}

/** The panel of the chosen tab. */
function Panel(
  { tab, pubkey, name, isMine }: {
    tab: ProfileTab;
    pubkey: string;
    name: string;
    isMine: boolean;
  },
) {
  const key = `${tab}|${pubkey}`;
  switch (tab) {
    case "notes":
    case "replies":
      return (
        <NoteFeed
          resetKey={key}
          load={(until) =>
            fetchAuthorNotes({
              author: pubkey,
              withReplies: tab === "replies",
              until,
            })}
          readAloudTitle={`${name} · ${
            tab === "replies" ? "Replies" : "Notes"
          }`}
          empty={
            <EmptyState
              title={isMine
                ? "You have not written any notes yet"
                : `No notes from ${name} yet`}
            >
              {isMine
                ? "Notes you write appear here."
                : "Notes they write appear here once this node has them."}
            </EmptyState>
          }
        />
      );
    case "articles":
      return (
        <ArticleList
          resetKey={key}
          loadPage={(until, limit) =>
            fetchArticles({ scope: "network", author: pubkey, until, limit })}
          readAloudTitle={`${name} · Articles`}
          empty={{
            title: isMine
              ? "You have not published an article yet"
              : `No articles from ${name} yet`,
            text: "Articles appear here once they have reached this node.",
          }}
        />
      );
    case "following":
      return (
        <PeopleList
          resetKey={key}
          grouped
          load={() => fetchFollowedPeople(pubkey)}
          empty={{
            title: isMine
              ? "You do not follow anyone yet"
              : `${name} does not follow anyone yet`,
            text: isMine
              ? "Follow people from their profiles, or find them in Search."
              : "Their follow list is empty, as far as this node knows.",
          }}
        />
      );
    case "followers":
      return (
        <PeopleList
          resetKey={key}
          load={() => fetchFollowerPeople(pubkey)}
          empty={{
            title: isMine
              ? "Nobody on this node follows you yet"
              : `Nobody on this node follows ${name} yet`,
            text: "People appear here once this node has their follow lists.",
          }}
        />
      );
  }
}

/** Explains a key the node knows nothing about. */
function OutsideHabitat({ name, named, isOwnerViewer }: {
  name: string;
  /** Whether the person has a name of their own (else `name` is a key). */
  named: boolean;
  isOwnerViewer: boolean;
}) {
  const range = status.value?.hops
    ? `${status.value.hops} follow ${status.value.hops === 1 ? "hop" : "hops"}`
    : "a few follow hops";
  return (
    <EmptyState title="Outside your habitat" icon={<User size={36} />}>
      This node keeps what people within {range}{" "}
      of its owner write, and nothing else. {named ? name : "This person"}{" "}
      is outside that range, so there is nothing from {named ? name : "them"}
      {" "}
      here yet. {isOwnerViewer
        ? "Follow them, and this node will fetch their notes."
        : "If the owner of this node follows them, their notes will be fetched."}
    </EmptyState>
  );
}

function ProfilePage({ pubkey }: { pubkey: string }) {
  const { query, pathname } = useRoute();
  const viewer = session.value?.pubkey ?? null;
  const isMine = viewer === pubkey;
  const profile = useProfile(pubkey);
  const name = displayNameOf(profile, pubkey);
  useDocumentTitle(name);
  const tab = tabOf(query.get("tab"));
  const hops = isMine ? 0 : distanceOf(pubkey);
  const stats = useAsync(() => fetchProfileStats(pubkey), [pubkey]);
  const followed = useAsync(
    () =>
      viewer && !isMine
        ? fetchFollowedBy(pubkey, viewer)
        : Promise.resolve<string[]>([]),
    [pubkey, viewer],
  );
  useEffect(() => {
    if (viewer) void loadViewerFollows(viewer).catch(() => undefined);
  }, [viewer]);
  // On narrow screens the tab strip scrolls: bring the chosen tab into view
  // (horizontally only, so the page itself does not move).
  useEffect(() => {
    const active = document.querySelector<HTMLElement>(
      ".profile-page .tabs__tab[aria-selected='true']",
    );
    const strip = active?.parentElement;
    if (!active || !strip || strip.scrollWidth <= strip.clientWidth) return;
    const a = active.getBoundingClientRect();
    const s = strip.getBoundingClientRect();
    strip.scrollLeft += a.left - s.left - (s.width - a.width) / 2;
  }, [tab]);

  const counted = stats.data;
  const unknown = !isMine && profile.loaded && !hasProfileFields(profile) &&
    hops === undefined && counted !== undefined &&
    counted.following + counted.followers + counted.notes === 0;

  const setTab = (next: ProfileTab) =>
    navigate(`${pathname}?tab=${next}`, { replace: true });

  return (
    <div class="page profile-page">
      <ProfileHeader
        pubkey={pubkey}
        profile={profile}
        viewer={viewer}
        hops={hops}
        stats={counted}
        statsFailed={stats.error !== undefined}
        followedBy={followed.data}
        onTab={setTab}
        onChanged={() => {
          stats.reload();
          followed.reload();
        }}
      />
      {unknown
        ? (
          <OutsideHabitat
            name={name}
            named={hasProfileFields(profile)}
            isOwnerViewer={isOwner.value}
          />
        )
        : (
          <>
            <Tabs
              label="Profile sections"
              value={tab}
              onChange={setTab}
              tabs={TABS}
            />
            <div class="profile-panel" role="tabpanel">
              <Panel tab={tab} pubkey={pubkey} name={name} isMine={isMine} />
            </div>
          </>
        )}
    </div>
  );
}

/** The Profile view. */
export default function ProfileView() {
  const { params } = useRoute();
  const raw = params.id ?? "";
  const pubkey = parsePubkey(
    /^[0-9a-fA-F]{64}$/.test(raw) ? raw.toLowerCase() : raw,
  );
  if (!pubkey) return <NoSuchPerson id={params.id} />;
  return <ProfilePage key={pubkey} pubkey={pubkey} />;
}
