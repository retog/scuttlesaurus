/**
 * `/dev/gallery`: every component in its states, with fixture data. This is
 * the visual test bench for the design system; it is not part of the product.
 * Append `?open=login|compose|modal|toast` to open a dialog on load.
 *
 * @module
 */
import { Bell, Heart, Plus, Search, Settings } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ArticleCard } from "../components/ArticleCard.tsx";
import { Avatar } from "../components/Avatar.tsx";
import { AuthorName } from "../components/AuthorName.tsx";
import { Button, IconButton } from "../components/Button.tsx";
import { Composer } from "../components/Composer.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { HopBadge } from "../components/HopBadge.tsx";
import { Logo, LogoMark } from "../components/Logo.tsx";
import { LoginDialog } from "../components/LoginDialog.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { Modal } from "../components/Modal.tsx";
import { NoteCard } from "../components/NoteCard.tsx";
import { NoteContent } from "../components/NoteContent.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { Skeleton, Spinner } from "../components/Spinner.tsx";
import { Tabs } from "../components/Tabs.tsx";
import { ThemeToggle } from "../components/ThemeToggle.tsx";
import { Timestamp } from "../components/Timestamp.tsx";
import { toast } from "../components/Toast.tsx";
import {
  ARTICLE_MARKDOWN,
  ARTICLES,
  GRAPH,
  NOTES,
  PEOPLE,
  STATUS,
} from "../fixtures.ts";
import { useDocumentTitle } from "../lib/hooks.ts";
import { formatCount } from "../lib/format.ts";
import { graph, status } from "../lib/node.ts";
import { seedProfile } from "../lib/profiles.ts";
import { useRoute } from "../lib/router.tsx";

function Section(
  { title, children, note }: {
    title: string;
    children: ComponentChildren;
    note?: string;
  },
) {
  return (
    <section class="gallery__section" aria-label={title}>
      <h2 class="gallery__heading">{title}</h2>
      {note && <p class="muted">{note}</p>}
      <div class="gallery__body">{children}</div>
    </section>
  );
}

/** The component gallery. */
export default function GalleryView() {
  useDocumentTitle("Gallery");
  const { query } = useRoute();
  const open = query.get("open");
  const [tab, setTab] = useState("notes");
  const [modal, setModal] = useState(open === "modal");
  const [login, setLogin] = useState(open === "login");
  const [liked, setLiked] = useState(true);

  // Fixture world: profiles and node state, only while the real ones are absent.
  useEffect(() => {
    for (const [key, p] of Object.entries(PEOPLE)) {
      if (key === "stranger") continue;
      seedProfile({
        pubkey: p.pubkey,
        name: p.name,
        displayName: p.displayName,
        about: p.about,
        picture: p.picture,
        nip05: p.nip05,
      });
    }
    if (!status.peek()) status.value = STATUS;
    if (!graph.peek()) graph.value = GRAPH;
    if (open === "toast") {
      toast("Note published", "success");
      toast("The relay said: blocked: not in your neighbourhood", "error");
    }
  }, []);

  const people = Object.values(PEOPLE);
  return (
    <div class="page gallery">
      <PageHeader
        title="Gallery"
        subtitle="Every component, in its states, with fixture data."
        actions={<ThemeToggle />}
      />

      <Section title="Logo">
        <div class="gallery__row">
          <Logo size={44} />
          <LogoMark size={64} />
          <LogoMark size={24} />
          <span style={{ color: "var(--accent)" }}>
            <LogoMark size={40} />
          </span>
        </div>
      </Section>

      <Section title="Buttons">
        <div class="gallery__row">
          <Button variant="primary">Primary</Button>
          <Button>Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="primary" icon={<Plus size={16} />}>With icon</Button>
          <Button variant="primary" disabled>Disabled</Button>
          <Button variant="primary" loading>Saving</Button>
          <Button variant="primary" size="sm">Small</Button>
          <Button variant="primary" size="lg">Large</Button>
        </div>
        <div class="gallery__row">
          <IconButton label="Search" icon={<Search size={20} />} />
          <IconButton
            label="Notifications"
            icon={<Bell size={20} />}
            count={3}
          />
          <IconButton
            label="Like"
            icon={<Heart size={18} fill={liked ? "currentColor" : "none"} />}
            active={liked}
            onClick={() => setLiked(!liked)}
            count={formatCount(1280)}
          />
          <IconButton
            label="Settings"
            icon={<Settings size={20} />}
            variant="primary"
          />
          <IconButton label="Disabled" icon={<Settings size={20} />} disabled />
          <ThemeToggle />
        </div>
      </Section>

      <Section title="Social distance" note="Hop badges and the hop palette.">
        <div class="gallery__row">
          <HopBadge hops={0} />
          <HopBadge hops={0} owner />
          <HopBadge hops={1} />
          <HopBadge hops={2} />
          <HopBadge hops={3} />
          <HopBadge hops={5} />
        </div>
      </Section>

      <Section title="Avatars and names">
        <div class="gallery__row">
          {[24, 32, 44, 64].map((size) => (
            <Avatar key={size} pubkey={PEOPLE.ada.pubkey} size={size} />
          ))}
          {people.map((p) => (
            <Avatar key={p.pubkey} pubkey={p.pubkey} size={44} />
          ))}
        </div>
        <div class="stack">
          {people.map((p) => <AuthorName key={p.pubkey} pubkey={p.pubkey} />)}
        </div>
        <div class="gallery__row muted">
          <Timestamp createdAt={Math.floor(Date.now() / 1000) - 20} />
          <Timestamp createdAt={Math.floor(Date.now() / 1000) - 600} />
          <Timestamp createdAt={Math.floor(Date.now() / 1000) - 7200} />
          <Timestamp createdAt={Math.floor(Date.now() / 1000) - 4 * 86400} />
          <Timestamp createdAt={Math.floor(Date.now() / 1000) - 40 * 86400} />
          <Timestamp createdAt={Math.floor(Date.now() / 1000) - 500 * 86400} />
        </div>
      </Section>

      <Section title="Tabs">
        <Tabs
          label="Example tabs"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "notes", label: "Notes", count: 128 },
            { value: "articles", label: "Articles", count: 4 },
            { value: "following", label: "Following" },
          ]}
        />
        <p class="muted">Selected: {tab}</p>
      </Section>

      <Section title="Loading and empty states">
        <div class="gallery__row">
          <Spinner />
          <Skeleton shape="avatar" />
        </div>
        <Skeleton shape="note" count={2} />
        <Skeleton shape="article" />
        <Skeleton count={3} />
        <div class="card">
          <EmptyState
            title="Nothing here yet"
            icon={<Bell size={36} />}
            action={<Button variant="primary">Find people to follow</Button>}
          >
            When people in your neighbourhood write, their notes will show up
            here.
          </EmptyState>
        </div>
        <div class="card">
          <EmptyState
            tone="error"
            title="The node is not answering"
            icon={<Bell size={36} />}
          >
            Check that Scuttlesaurus is running and try again.
          </EmptyState>
        </div>
      </Section>

      <Section title="Notes: content">
        <div class="card" style={{ padding: "16px 20px" }}>
          <NoteContent content={NOTES.mention.content} />
        </div>
        <div class="card" style={{ padding: "16px 20px" }}>
          <NoteContent content={NOTES.links.content} />
        </div>
      </Section>

      <Section
        title="Notes: cards"
        note="Default feed items with actions, an image, a gallery, and a repost context."
      >
        <NoteCard
          note={NOTES.plain}
          replyCount={4}
          repostCount={0}
          likeCount={1280}
          liked={liked}
          onReply={() =>
            toast("Reply")}
          onRepost={() => toast("Repost")}
          onLike={() => setLiked(!liked)}
        />
        <NoteCard
          note={NOTES.links}
          replyCount={0}
          likeCount={3}
          onReply={() => {}}
          onLike={() => {}}
          context="Reposted by Ada Lindqvist"
        />
        <NoteCard
          note={NOTES.mention}
          replyCount={1}
          likeCount={12}
          reposted
          onReply={() => {}}
          onRepost={() => {}}
          onLike={() => {}}
        />
        <NoteCard
          note={NOTES.image}
          replyCount={2}
          likeCount={41}
          onReply={() => {}}
          onRepost={() => {}}
          onLike={() => {}}
        />
        <NoteCard note={NOTES.gallery} onReply={() => {}} onLike={() => {}} />
        <NoteCard note={{ ...NOTES.long, pubkey: PEOPLE.stranger.pubkey }} />
      </Section>

      <Section title="Notes: compact and focused">
        <NoteCard variant="compact" note={NOTES.long} />
        <NoteCard variant="compact" note={NOTES.image} />
        <NoteCard
          variant="focused"
          note={NOTES.long}
          replyCount={7}
          repostCount={2}
          likeCount={96}
          onReply={() => {}}
          onRepost={() => {}}
          onLike={() => {}}
        />
      </Section>

      <Section title="Articles: cards">
        {ARTICLES.map((a) => <ArticleCard key={a.naddr} article={a} />)}
        <ArticleCard article={ARTICLES[0]} variant="compact" />
      </Section>

      <Section title="Markdown (long-form reading)">
        <article class="card article-sheet">
          <Markdown source={ARTICLE_MARKDOWN} />
        </article>
      </Section>

      <Section title="Composer">
        <div class="card" style={{ padding: "16px 20px" }}>
          <Composer
            placeholder="What is on your mind?"
            onSubmit={() =>
              toast("Composer submitted (nothing was published)", "success")}
            onCancel={() => {}}
          />
        </div>
      </Section>

      <Section title="Dialogs and toasts">
        <div class="gallery__row">
          <Button onClick={() => setModal(true)}>Open modal</Button>
          <Button onClick={() => setLogin(true)}>Open login dialog</Button>
          <Button onClick={() => toast("Note published", "success")}>
            Success toast
          </Button>
          <Button onClick={() => toast("Something to know")}>Info toast</Button>
          <Button onClick={() => toast("The relay refused the note", "error")}>
            Error toast
          </Button>
        </div>
      </Section>

      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title="A modal dialog"
      >
        <p>
          Native <code>&lt;dialog&gt;</code>{" "}
          underneath: focus is trapped, Esc closes it, and the backdrop click
          does too.
        </p>
        <div
          class="row"
          style={{ marginTop: "16px", justifyContent: "flex-end" }}
        >
          <Button variant="ghost" onClick={() => setModal(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => setModal(false)}>
            Okay
          </Button>
        </div>
      </Modal>
      <LoginDialog open={login} onClose={() => setLogin(false)} />
    </div>
  );
}
