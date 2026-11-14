/**
 * Notifications: replies to, mentions of, reactions to and reposts of the
 * signed-in person's notes by other people, newest first. Items newer than the
 * last visit are marked.
 *
 * @module
 */
import { AtSign, Bell, Heart, MessageCircle, Repeat2 } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useRef } from "preact/hooks";
import { AuthorName } from "../components/AuthorName.tsx";
import { Avatar } from "../components/Avatar.tsx";
import { Button } from "../components/Button.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { PagedList } from "../components/PagedList.tsx";
import { Timestamp } from "../components/Timestamp.tsx";
import {
  fetchNotifications,
  type NotificationRow,
  type NotificationType,
} from "../lib/feed.ts";
import { useDocumentTitle } from "../lib/hooks.ts";
import { notePath } from "../lib/nostr.ts";
import { Link, navigate } from "../lib/router.tsx";
import { session } from "../lib/session.ts";
import { openLogin } from "../lib/ui.ts";

const WHAT: Record<NotificationType, string> = {
  reply: "replied to your note",
  mention: "mentioned you",
  like: "liked your note",
  repost: "reposted your note",
};

const ICON: Record<NotificationType, ComponentChildren> = {
  reply: <MessageCircle size={12} />,
  mention: <AtSign size={12} />,
  like: <Heart size={12} />,
  repost: <Repeat2 size={12} />,
};

function seenKey(pubkey: string): string {
  return `scuttlesaurus.notifications.seen.${pubkey}`;
}

function readSeen(pubkey: string): number {
  try {
    return Number(localStorage.getItem(seenKey(pubkey))) || 0;
  } catch {
    return 0;
  }
}

function writeSeen(pubkey: string): void {
  try {
    localStorage.setItem(
      seenKey(pubkey),
      String(Math.floor(Date.now() / 1000)),
    );
  } catch {
    // marks just will not survive a reload
  }
}

/** A short plain-text piece of a note: links dropped, whitespace collapsed. */
function excerptOf(text: string): string {
  const plain = text.replace(/\bhttps?:\/\/\S+/g, "").replace(/\s+/g, " ")
    .trim();
  return plain.length > 160 ? `${plain.slice(0, 157)}…` : plain;
}

function Notification(
  { item, fresh }: { item: NotificationRow; fresh: boolean },
) {
  const href = notePath(item.noteId);
  const excerpt = excerptOf(item.excerpt);
  return (
    <article
      class={`card notification${fresh ? " notification--new" : ""}`}
      onClick={(event) => {
        if ((event.target as Element).closest("a, button")) return;
        navigate(href);
      }}
    >
      <div class="notification__avatar">
        <Avatar pubkey={item.actor} size={40} />
        <span
          class={`notification__badge notification__badge--${item.type}`}
          aria-hidden="true"
        >
          {ICON[item.type]}
        </span>
      </div>
      <div class="notification__body">
        <p class="notification__line">
          <AuthorName pubkey={item.actor} showNip05={false} showHops={false} />
          {" "}
          <span class="notification__what">
            {WHAT[item.type]}
            {item.type === "like" && item.reaction && item.reaction !== "+"
              ? ` ${item.reaction}`
              : ""}
          </span>
        </p>
        {excerpt && <p class="notification__excerpt">{excerpt}</p>}
      </div>
      <Link class="notification__time" to={href}>
        {fresh && <span class="visually-hidden">New:</span>}
        <Timestamp createdAt={item.createdAt} />
      </Link>
    </article>
  );
}

function Feed({ pubkey }: { pubkey: string }) {
  // The time of the previous visit, kept for as long as the page is open.
  const before = useRef<number>(readSeen(pubkey));
  return (
    <PagedList<NotificationRow>
      resetKey={pubkey}
      load={(until) => fetchNotifications(pubkey, { until })}
      keyOf={(n) => `${n.id}:${n.type}`}
      cursorOf={(n) => n.createdAt}
      onPage={() => writeSeen(pubkey)}
      render={(n) => (
        <Notification item={n} fresh={n.createdAt > before.current} />
      )}
      empty={
        <EmptyState title="Nothing yet" icon={<Bell size={36} />}>
          When people reply to you, mention you, like or repost your notes, it
          shows up here.
        </EmptyState>
      }
    />
  );
}

/** The Notifications view. */
export default function NotificationsView() {
  useDocumentTitle("Notifications");
  const me = session.value?.pubkey;
  return (
    <div class="page">
      <PageHeader title="Notifications" />
      {me ? <Feed key={me} pubkey={me} /> : (
        <EmptyState
          title="Sign in to see your notifications"
          icon={<Bell size={36} />}
          action={
            <Button variant="primary" onClick={openLogin}>Sign in</Button>
          }
        >
          Replies, mentions, likes and reposts of your notes are collected here.
        </EmptyState>
      )}
    </div>
  );
}
