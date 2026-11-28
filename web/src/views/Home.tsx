/**
 * Home: the notes of the people you follow, or of the whole replicated
 * network, with a composer on top and a "Show N new notes" pill for notes that
 * arrive while the page is open.
 *
 * @module
 */
import { ArrowUp, Inbox, UserPlus } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Avatar } from "../components/Avatar.tsx";
import { Button } from "../components/Button.tsx";
import { Composer } from "../components/Composer.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { NoteFeed } from "../components/NoteFeed.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { Skeleton } from "../components/Spinner.tsx";
import { Tabs } from "../components/Tabs.tsx";
import { toast } from "../components/Toast.tsx";
import { submitNote, viewerKey } from "../lib/actions.ts";
import {
  fetchFeed,
  fetchFeedStatus,
  fetchFollowing,
  noteFromEvent,
  type NoteRow,
} from "../lib/feed.ts";
import { useAsync, useDocumentTitle } from "../lib/hooks.ts";
import { nodeError, status } from "../lib/node.ts";
import { subscribe } from "../lib/relay.ts";
import { canSign, session } from "../lib/session.ts";
import { openLogin } from "../lib/ui.ts";

type Scope = "following" | "network";

const TAB_KEY = "scuttlesaurus.home.tab";

function savedScope(): Scope {
  try {
    return localStorage.getItem(TAB_KEY) === "network"
      ? "network"
      : "following";
  } catch {
    return "following";
  }
}

function remember(scope: Scope): void {
  try {
    localStorage.setItem(TAB_KEY, scope);
  } catch {
    // the choice just does not survive a reload
  }
}

/** The empty feed, with the reason found out only when it is shown. */
function EmptyFeed(
  { scope, viewer, onNetwork }: {
    scope: Scope;
    viewer: string | null;
    onNetwork: () => void;
  },
) {
  const { data } = useAsync(() => fetchFeedStatus(viewer), [viewer]);
  if (!data) return <Skeleton shape="line" count={3} />;
  if (!data.anyNotes) {
    return (
      <EmptyState title="Nothing here yet" icon={<Inbox size={36} />}>
        This node is still fetching notes from the people around its owner. They
        will show up here as they arrive.
      </EmptyState>
    );
  }
  if (scope === "following" && data.follows === 0) {
    return (
      <EmptyState
        title="You follow nobody yet"
        icon={<UserPlus size={36} />}
        action={<Button variant="primary" to="/search">Find people</Button>}
      >
        {viewer === session.value?.pubkey
          ? "Follow a few people and their notes will gather here."
          : "The node's owner follows nobody yet, so this feed is empty."}
      </EmptyState>
    );
  }
  return (
    <EmptyState
      title="No notes yet"
      icon={<Inbox size={36} />}
      action={scope === "following"
        ? <Button onClick={onNetwork}>Look at the whole network</Button>
        : undefined}
    >
      {scope === "following"
        ? "The people you follow have not posted anything this node holds."
        : "There are no notes in this node's store yet."}
    </EmptyState>
  );
}

/** The inline composer, or an invitation to sign in. */
function HomeComposer({ onPosted }: { onPosted: (note: NoteRow) => void }) {
  const me = session.value?.pubkey;
  if (!canSign.value || !me) {
    return (
      <div class="card home-invite">
        <p class="muted">
          {me
            ? "You are browsing read-only."
            : "Sign in to post, reply and like."}
        </p>
        <Button size="sm" variant="primary" onClick={openLogin}>
          Sign in
        </Button>
      </div>
    );
  }
  return (
    <div class="card home-compose">
      <Avatar pubkey={me} size={40} />
      <Composer
        compact
        placeholder="What is on your mind?"
        onSubmit={async (content) => {
          const event = await submitNote(content);
          const row = noteFromEvent(event);
          if (row) onPosted(row);
          toast("Note published", "success");
        }}
      />
    </div>
  );
}

/** The Home view. */
export default function HomeView() {
  useDocumentTitle("Home");
  const viewer = viewerKey.value;
  const signedIn = session.value !== null;
  const [scope, setScope] = useState<Scope>(savedScope);
  const [added, setAdded] = useState<NoteRow[]>([]);
  const [waiting, setWaiting] = useState<NoteRow[]>([]);
  const following = useRef<Set<string> | undefined>(undefined);
  const topRef = useRef<HTMLDivElement>(null);

  const choose = (next: Scope) => {
    remember(next);
    setScope(next);
  };

  // Notes posted or received while the page is open.
  useEffect(() => {
    setAdded([]);
    setWaiting([]);
    following.current = undefined;
    let closed = false;
    if (scope === "following" && viewer) {
      fetchFollowing(viewer).then((set) => {
        if (!closed) following.current = set;
      }, () => {});
    }
    const close = subscribe(
      [{ kinds: [1, 6], since: Math.floor(Date.now() / 1000) }],
      (event) => {
        const note = noteFromEvent(event);
        if (!note) return;
        const actor = note.repostedBy?.pubkey ?? note.pubkey;
        const mine = actor === session.value?.pubkey;
        if (!mine && scope === "following") {
          if (actor !== viewer && !following.current?.has(actor)) return;
        }
        const add = (list: NoteRow[]) =>
          list.some((n) => n.key === note.key) ? list : [note, ...list];
        if (mine) setAdded(add);
        else setWaiting(add);
      },
    );
    return () => {
      closed = true;
      close();
    };
  }, [scope, viewer]);

  const showWaiting = () => {
    setAdded((list) => [...waiting, ...list]);
    setWaiting([]);
    globalThis.scrollTo({ top: 0, behavior: "smooth" });
  };

  // Until the node says who owns it, there is no point of view to read from.
  const ready = viewer !== null || status.value !== null ||
    nodeError.value !== null;
  const subtitle = signedIn
    ? undefined
    : status.value?.owner
    ? "Seen from the node owner's point of view"
    : undefined;

  return (
    <div class="page home">
      <PageHeader title="Home" subtitle={subtitle} />
      <HomeComposer
        onPosted={(note) =>
          setAdded((list) =>
            list.some((n) => n.key === note.key) ? list : [note, ...list]
          )}
      />
      <Tabs<Scope>
        label="Which notes"
        value={scope}
        onChange={choose}
        tabs={[
          { value: "following", label: "Following" },
          { value: "network", label: "Network" },
        ]}
      />
      <div class="home__new" ref={topRef}>
        {waiting.length > 0 && (
          <Button
            class="home__pill"
            variant="primary"
            size="sm"
            icon={<ArrowUp size={16} />}
            onClick={showWaiting}
          >
            Show {waiting.length} new {waiting.length === 1 ? "note" : "notes"}
          </Button>
        )}
      </div>
      {ready
        ? (
          <NoteFeed
            resetKey={`${scope}:${viewer}`}
            load={(until) => fetchFeed({ scope, viewer, until })}
            readAloudTitle={scope === "following"
              ? "Home · Following"
              : "Home · Network"}
            prepend={added}
            empty={
              <EmptyFeed
                scope={scope}
                viewer={viewer}
                onNetwork={() => choose("network")}
              />
            }
          />
        )
        : <Skeleton shape="note" count={4} />}
    </div>
  );
}
