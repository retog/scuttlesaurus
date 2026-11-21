/**
 * A note with its thread: the chain of parents above, the note itself, a reply
 * composer and the replies as a tree (two levels of indentation, deeper
 * replies flattened with a "Replying to …" hint).
 *
 * @module
 */
import { ArrowLeft, FileQuestion } from "lucide-preact";
import { useEffect, useRef } from "preact/hooks";
import { AuthorName } from "../components/AuthorName.tsx";
import { Avatar } from "../components/Avatar.tsx";
import { Button, IconButton } from "../components/Button.tsx";
import { Composer } from "../components/Composer.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { NoteItem } from "../components/NoteItem.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { Skeleton } from "../components/Spinner.tsx";
import { toast } from "../components/Toast.tsx";
import {
  hiddenNotes,
  loadStats,
  submitNote,
  useNoteStats,
} from "../lib/actions.ts";
import {
  fetchReactors,
  fetchThread,
  type MissingNote,
  type NoteRow,
  type Thread,
  toEvent,
} from "../lib/feed.ts";
import { useAsync, useDocumentTitle } from "../lib/hooks.ts";
import { formatCount } from "../lib/format.ts";
import { status } from "../lib/node.ts";
import { parseEventId, toNote } from "../lib/nostr.ts";
import { displayNameOf, useProfile } from "../lib/profiles.ts";
import { subscribe } from "../lib/relay.ts";
import { navigate, useRoute } from "../lib/router.tsx";

interface Loaded {
  thread: Thread;
  reactors: string[];
}

async function loadThread(id: string): Promise<Loaded> {
  const thread = await fetchThread(id);
  if (!thread.focus) return { thread, reactors: [] };
  const ids = [
    ...thread.ancestors.flatMap((a) => "missing" in a ? [] : [a.id]),
    id,
    ...thread.replies.map((r) => r.note.id),
  ];
  // Counts are in before the thread is shown, so nothing moves afterwards.
  const [reactors] = await Promise.all([fetchReactors(id), loadStats(ids)]);
  return { thread, reactors };
}

function Outside({ children }: { children?: string }) {
  const hops = status.value?.hops;
  return (
    <>
      {children ?? "This note is outside your habitat"}{" "}
      — only notes from people within {hops ?? "a few"}{" "}
      {hops === 1 ? "hop" : "hops"} are kept here.
    </>
  );
}

function Missing({ note }: { note: MissingNote }) {
  return (
    <div class="card thread__missing">
      <p>
        <Outside />
      </p>
      <span class="mono muted">{toNote(note.id).slice(0, 16)}…</span>
    </div>
  );
}

function Reactors({ people, total }: { people: string[]; total: number }) {
  if (people.length === 0 || total === 0) return null;
  const shown = people.slice(0, 3);
  const others = total - shown.length;
  return (
    <div class="thread__reactors">
      <span class="thread__faces">
        {shown.map((pubkey) => (
          <Avatar
            key={pubkey}
            pubkey={pubkey}
            size={24}
          />
        ))}
      </span>
      <span class="muted">
        Liked by {shown.map((pubkey, i) => (
          <span key={pubkey}>
            {i > 0
              ? (i === shown.length - 1 && others <= 0 ? " and " : ", ")
              : ""}
            <AuthorName
              pubkey={pubkey}
              showNip05={false}
              showHops={false}
            />
          </span>
        ))}
        {others > 0 &&
          ` and ${formatCount(others)} ${others === 1 ? "other" : "others"}`}
      </span>
    </div>
  );
}

function ReplyingTo({ pubkey }: { pubkey: string }) {
  return (
    <span>
      Replying to{" "}
      <AuthorName pubkey={pubkey} showNip05={false} showHops={false} />
    </span>
  );
}

function ThreadTitle({ note }: { note: NoteRow }) {
  const profile = useProfile(note.pubkey);
  const excerpt = note.content.replace(/\s+/g, " ").trim().slice(0, 50);
  useDocumentTitle(`${displayNameOf(profile, note.pubkey)}: ${excerpt}`);
  return null;
}

function ThreadBody(
  { thread, reactors, onReplied }: {
    thread: Thread;
    reactors: string[];
    onReplied: () => void;
  },
) {
  const focus = thread.focus!;
  const likes = useNoteStats(focus.id).likes;
  const focusRef = useRef<HTMLDivElement>(null);
  // Bring the note into view below its parents.
  useEffect(() => {
    if (thread.ancestors.length === 0) return;
    // After the router has scrolled to the top.
    const timer = setTimeout(
      () => focusRef.current?.scrollIntoView({ block: "start" }),
      80,
    );
    return () => clearTimeout(timer);
  }, [focus.id]);
  const hidden = hiddenNotes.value;
  return (
    <div class="thread">
      <ThreadTitle note={focus} />
      {thread.ancestors.length > 0 && (
        <div class="thread__ancestors" aria-label="Earlier in this thread">
          {thread.ancestors.map((a) => (
            <div class="thread__ancestor" key={a.id}>
              {"missing" in a ? <Missing note={a} /> : <NoteItem note={a} />}
            </div>
          ))}
        </div>
      )}
      <div class="thread__focus" ref={focusRef}>
        <NoteItem note={focus} variant="focused" />
        <Reactors people={reactors} total={likes} />
      </div>
      <div class="card thread__compose">
        <Composer
          compact
          placeholder="Write a reply"
          submitLabel="Reply"
          onSubmit={async (content) => {
            await submitNote(content, toEvent(focus));
            toast("Reply sent", "success");
            onReplied();
          }}
        />
      </div>
      {thread.replies.length > 0 && (
        <div class="thread__replies" aria-label="Replies">
          {thread.replies
            .filter((r) =>
              !hidden.has(r.note.id)
            )
            .map((r) => (
              <div
                class={`thread__reply thread__reply--${r.depth}`}
                key={r.note.id}
              >
                <NoteItem
                  note={r.note}
                  context={r.replyingTo
                    ? <ReplyingTo pubkey={r.replyingTo} />
                    : undefined}
                />
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

/** The Note view. */
export default function NoteView() {
  const { params } = useRoute();
  const id = parseEventId(params.id ?? "");
  useDocumentTitle("Note");
  const { data, error, loading, reload } = useAsync(
    () => id ? loadThread(id) : Promise.resolve(undefined),
    [id],
  );

  // New replies to this thread (from anybody, also the compose dialog).
  const root = data?.thread.focus?.root ?? id;
  useEffect(() => {
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const close = subscribe(
      [{ kinds: [1], "#e": [root], since: Math.floor(Date.now() / 1000) }],
      () => {
        clearTimeout(timer);
        timer = setTimeout(reload, 200);
      },
    );
    return () => {
      clearTimeout(timer);
      close();
    };
  }, [root]);

  const back = (
    <IconButton
      label="Back"
      icon={<ArrowLeft size={20} />}
      onClick={() => history.length > 1 ? history.back() : navigate("/")}
    />
  );
  const header = <PageHeader title="Note" actions={back} />;

  if (!id) {
    return (
      <div class="page">
        {header}
        <EmptyState
          title="That is not a note address"
          icon={<FileQuestion size={36} />}
        >
          Notes are opened with a note1…, nevent1… or hex id.
        </EmptyState>
      </div>
    );
  }
  if (!data && loading) {
    return (
      <div class="page">
        {header}
        <Skeleton shape="note" count={3} />
      </div>
    );
  }
  if (!data) {
    return (
      <div class="page">
        {header}
        <EmptyState
          tone="error"
          title="Could not load the note"
          action={<Button onClick={reload}>Try again</Button>}
        >
          {error?.message}
        </EmptyState>
      </div>
    );
  }
  const { thread, reactors } = data;
  if (!thread.focus || hiddenNotes.value.has(thread.focus.id)) {
    return (
      <div class="page">
        {header}
        <EmptyState
          title="Note not found"
          icon={<FileQuestion size={36} />}
          action={<Button to="/">Back to Home</Button>}
        >
          <Outside>This note is not here</Outside>{" "}
          It may also have been deleted.
        </EmptyState>
      </div>
    );
  }
  return (
    <div class="page">
      {header}
      <ThreadBody
        thread={thread}
        reactors={reactors}
        onReplied={reload}
      />
    </div>
  );
}
