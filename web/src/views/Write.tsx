/**
 * The article editor, for a new article (`/write`) or for an own article or
 * draft (`/write/:naddr`). Title, summary, cover image, topics and a Markdown
 * body; drafts are kind 30024, publishing is kind 30023. Unsaved work is kept
 * in this browser per article until it is saved.
 *
 * @module
 */
import { ImagePlus, Upload, X } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../components/Button.tsx";
import { ConfirmButton } from "../components/ConfirmButton.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { MarkdownEditor } from "../components/MarkdownEditor.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { Skeleton } from "../components/Spinner.tsx";
import { TagInput } from "../components/TagInput.tsx";
import { toast } from "../components/Toast.tsx";
import { uploadBlob } from "../lib/blossom.ts";
import {
  ARTICLE_KIND,
  type ArticleRow,
  deleteAddress,
  DRAFT_KIND,
  type EditableDoc,
  explainError,
  fetchDrafts,
  fetchOwnVersions,
  makeIdentifier,
  publishArticle,
  saveDraft,
} from "../lib/articles.ts";
import { readingTime, relativeTime } from "../lib/format.ts";
import { useAsync, useDocumentTitle } from "../lib/hooks.ts";
import { articlePath, decodeNip19, toNaddr } from "../lib/nostr.ts";
import { Link, navigate, useRoute } from "../lib/router.tsx";
import { canSign, session } from "../lib/session.ts";
import { openLogin } from "../lib/ui.ts";

/** The text of an article as the form holds it. */
interface Form {
  title: string;
  summary: string;
  image: string;
  topics: string[];
  content: string;
}

const BLANK: Form = {
  title: "",
  summary: "",
  image: "",
  topics: [],
  content: "",
};

/** The stored version this editor opened or last saved. */
interface Version {
  versionId: string;
  createdAt: number;
  publishedAt?: number;
}

type Phase = "loading" | "ready" | "missing" | "foreign" | "error";

function formOf(doc: EditableDoc): Form {
  return {
    title: doc.title,
    summary: doc.summary,
    image: doc.image,
    topics: doc.topics,
    content: doc.content,
  };
}

function snapshot(form: Form): string {
  return JSON.stringify(form);
}

function backupKey(identifier: string | undefined): string {
  return `scuttlesaurus.write.${identifier ?? "new"}`;
}

function readBackup(key: string): Form | undefined {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!parsed || typeof parsed !== "object") return undefined;
    const f = parsed as Record<string, unknown>;
    if (
      typeof f.title !== "string" || typeof f.summary !== "string" ||
      typeof f.image !== "string" || typeof f.content !== "string" ||
      !Array.isArray(f.topics)
    ) return undefined;
    return {
      title: f.title,
      summary: f.summary,
      image: f.image,
      content: f.content,
      topics: f.topics.filter((t): t is string => typeof t === "string"),
    };
  } catch {
    return undefined;
  }
}

function writeBackup(key: string, form: Form): void {
  try {
    localStorage.setItem(key, JSON.stringify(form));
  } catch {
    // storage unavailable: the work lasts for this page view
  }
}

function clearBackup(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // nothing stored
  }
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** The editor page: a signed-in person's article or draft, or a new one. */
export default function WriteView() {
  const { params } = useRoute();
  if (!canSign.value) {
    return (
      <div class="page">
        <PageHeader title="Write" />
        <EmptyState
          title="Sign in to write"
          icon={<ImagePlus size={36} />}
          action={
            <Button variant="primary" onClick={openLogin}>Sign in</Button>
          }
        >
          Articles are signed with your key. You can read everything without
          signing in.
        </EmptyState>
      </div>
    );
  }
  return <Editor key={params.naddr ?? "new"} naddr={params.naddr} />;
}

/** The form, loading and saving for one article. */
function Editor({ naddr }: { naddr?: string }) {
  const me = session.value?.pubkey ?? "";
  const target = naddr ? decodeNip19(naddr) : undefined;
  const isEdit = naddr !== undefined;
  const targetAddress = target?.type === "naddr" ? target : undefined;

  const [phase, setPhase] = useState<Phase>(isEdit ? "loading" : "ready");
  const [form, setForm] = useState<Form>(() =>
    isEdit ? BLANK : readBackup(backupKey(undefined)) ?? BLANK
  );
  const [saved, setSaved] = useState<string>(() => snapshot(BLANK));
  const [identifier, setIdentifier] = useState<string | undefined>(
    targetAddress?.identifier,
  );
  const [published, setPublished] = useState<Version>();
  const [draft, setDraft] = useState<Version>();
  const [busy, setBusy] = useState<"" | "draft" | "publish" | "cover">("");
  const [error, setError] = useState<string>();
  const [coverUrl, setCoverUrl] = useState("");
  const coverInput = useRef<HTMLInputElement>(null);

  const dirty = phase === "ready" && snapshot(form) !== saved;
  const kindLabel = published
    ? "Edit article"
    : draft
    ? "Edit draft"
    : "New article";
  useDocumentTitle(phase === "ready" ? form.title || kindLabel : undefined);

  // Load an own article or draft, and restore unsaved work for it.
  useEffect(() => {
    if (!isEdit) return;
    if (!targetAddress) {
      setPhase("missing");
      return;
    }
    if (targetAddress.pubkey !== me) {
      setPhase("foreign");
      return;
    }
    let cancelled = false;
    fetchOwnVersions(targetAddress.identifier, me).then((docs) => {
      if (cancelled) return;
      const article = docs.find((doc) => doc.kind === ARTICLE_KIND);
      const draftDoc = docs.find((doc) => doc.kind === DRAFT_KIND);
      const wanted = targetAddress.kind === DRAFT_KIND ? draftDoc : article;
      if (article) {
        setPublished({
          versionId: article.versionId,
          createdAt: article.createdAt,
          publishedAt: article.publishedAt,
        });
      }
      if (draftDoc) {
        setDraft({
          versionId: draftDoc.versionId,
          createdAt: draftDoc.createdAt,
          publishedAt: draftDoc.publishedAt,
        });
      }
      if (!wanted) {
        setPhase("missing");
        return;
      }
      const base = formOf(wanted);
      setForm(readBackup(backupKey(targetAddress.identifier)) ?? base);
      setSaved(snapshot(base));
      setPhase("ready");
    }, (reason: unknown) => {
      if (cancelled) return;
      setError(explainError(reason));
      setPhase("error");
    });
    return () => {
      cancelled = true;
    };
  }, [naddr]);

  // Keep the unsaved work in this browser; drop it when nothing is unsaved.
  useEffect(() => {
    if (phase !== "ready") return;
    const key = backupKey(identifier);
    if (dirty) writeBackup(key, form);
    else clearBackup(key);
  }, [form, dirty, identifier, phase]);

  // Warn before leaving with unsaved changes: closing the page, and in-app links.
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    const guardLinks = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!anchor) return;
      const url = new URL(
        anchor.getAttribute("href") ?? "",
        globalThis.location.href,
      );
      if (url.origin !== globalThis.location.origin) return;
      if (url.href === globalThis.location.href) return;
      const leave = globalThis.confirm(
        "Leave the editor? Your unsaved changes are kept in this browser but not saved as a draft.",
      );
      if (!leave) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", guardLinks, true);
    return () => {
      removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", guardLinks, true);
    };
  }, [dirty]);

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  const uploadCover = async (file: File) => {
    setBusy("cover");
    try {
      const blob = await uploadBlob(file);
      set({ image: blob.url });
    } catch (reason) {
      toast(explainError(reason), "error");
    } finally {
      setBusy("");
    }
  };

  const useCoverUrl = () => {
    const url = coverUrl.trim();
    if (!/^https?:\/\/\S+$/i.test(url)) {
      toast("Paste a full web address that starts with https://", "error");
      return;
    }
    set({ image: url });
    setCoverUrl("");
  };

  const save = async (mode: "draft" | "publish") => {
    setError(undefined);
    const title = form.title.trim();
    if (mode === "publish") {
      if (!title) {
        setError("Give the article a title before publishing.");
        return;
      }
      if (!form.content.trim()) {
        setError("The article has no text yet.");
        return;
      }
    }
    const id = identifier ?? makeIdentifier(title || "untitled");
    const fields = {
      identifier: id,
      title: form.title,
      summary: form.summary,
      image: form.image,
      tags: form.topics,
      content: form.content,
    };
    setBusy(mode);
    try {
      if (mode === "draft") {
        const event = await saveDraft({
          ...fields,
          publishedAt: published?.publishedAt,
          after: draft?.createdAt,
        });
        setDraft({ versionId: event.id, createdAt: event.created_at });
        setIdentifier(id);
        setSaved(snapshot(form));
        clearBackup(backupKey(identifier));
        clearBackup(backupKey(undefined));
        toast("Draft saved", "success");
        if (!isEdit) {
          navigate(`/write/${toNaddr(DRAFT_KIND, me, id)}`, { replace: true });
        }
      } else {
        await publishArticle({
          ...fields,
          publishedAt: published?.publishedAt ??
            Math.floor(Date.now() / 1000),
          after: published?.createdAt,
        });
        if (draft) {
          await deleteAddress({
            kind: DRAFT_KIND,
            pubkey: me,
            identifier: id,
            versionId: draft.versionId,
          }).catch(() => undefined);
        }
        setSaved(snapshot(form));
        clearBackup(backupKey(identifier));
        clearBackup(backupKey(undefined));
        toast(published ? "Article updated" : "Article published", "success");
        navigate(articlePath(toNaddr(ARTICLE_KIND, me, id)), { replace: true });
      }
    } catch (reason) {
      setError(explainError(reason));
    } finally {
      setBusy("");
    }
  };

  if (phase === "loading") {
    return (
      <div class="page" aria-busy="true">
        <Skeleton shape="line" count={5} />
      </div>
    );
  }
  if (phase === "foreign") {
    return (
      <div class="page">
        <EmptyState title="You can only edit your own writing">
          This article is by somebody else.
        </EmptyState>
      </div>
    );
  }
  if (phase === "missing" || phase === "error") {
    return (
      <div class="page">
        <PageHeader title="Write" />
        <EmptyState
          tone={phase === "error" ? "error" : "neutral"}
          title={phase === "error"
            ? "This article could not be loaded"
            : "No article or draft of yours has this address"}
          action={<Button to="/write">Start a new article</Button>}
        >
          {error}
        </EmptyState>
      </div>
    );
  }

  const words = countWords(form.content);
  const headingSubtitle = published
    ? "Publishing again replaces the published version. Your readers see the update."
    : draft
    ? "A draft is visible only to you until you publish it."
    : "Drafts stay private to you until you publish.";

  return (
    <div class="page write">
      <PageHeader
        title={kindLabel}
        subtitle={headingSubtitle}
        actions={published && identifier
          ? (
            <Button to={articlePath(toNaddr(ARTICLE_KIND, me, identifier))}>
              View article
            </Button>
          )
          : undefined}
      />
      {!isEdit && me && <DraftList author={me} />}

      <div class="write__form">
        <label class="visually-hidden" for="write-title">Title</label>
        <input
          id="write-title"
          class="write__title"
          type="text"
          placeholder="Title"
          maxLength={300}
          value={form.title}
          onInput={(e) => set({ title: (e.target as HTMLInputElement).value })}
        />

        <label class="field">
          <span class="field__label">Summary</span>
          <textarea
            class="field__input write__summary"
            rows={2}
            maxLength={500}
            placeholder="One or two sentences that stand in the feed"
            value={form.summary}
            onInput={(e) =>
              set({ summary: (e.target as HTMLTextAreaElement).value })}
          />
        </label>

        <section class="write__cover" aria-label="Cover image">
          <span class="field__label">Cover image</span>
          {form.image
            ? (
              <div class="write__cover-preview">
                <img src={form.image} alt="" decoding="async" />
                <div class="write__cover-actions">
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === "cover"}
                    icon={<Upload size={15} aria-hidden="true" />}
                    onClick={() => coverInput.current?.click()}
                  >
                    Replace
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<X size={15} aria-hidden="true" />}
                    onClick={() => set({ image: "" })}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            )
            : (
              <div class="write__cover-empty">
                <Button
                  variant="secondary"
                  loading={busy === "cover"}
                  icon={<ImagePlus size={18} aria-hidden="true" />}
                  onClick={() => coverInput.current?.click()}
                >
                  Upload cover
                </Button>
                <div class="write__cover-url">
                  <input
                    class="field__input"
                    type="url"
                    placeholder="or paste an image address"
                    aria-label="Cover image address"
                    value={coverUrl}
                    onInput={(e) =>
                      setCoverUrl((e.target as HTMLInputElement).value)}
                  />
                  <Button
                    size="sm"
                    disabled={!coverUrl.trim()}
                    onClick={useCoverUrl}
                  >
                    Use address
                  </Button>
                </div>
              </div>
            )}
          <input
            ref={coverInput}
            class="visually-hidden"
            type="file"
            accept="image/*"
            tabIndex={-1}
            onChange={(e) => {
              const input = e.target as HTMLInputElement;
              const picked = input.files?.[0];
              input.value = "";
              if (picked) uploadCover(picked);
            }}
          />
        </section>

        <div class="field">
          <span class="field__label">Topics</span>
          <TagInput
            label="Topics"
            placeholder="Add a topic, then press Enter"
            value={form.topics}
            onChange={(topics) => set({ topics })}
          />
        </div>

        <MarkdownEditor
          value={form.content}
          onChange={(content) => set({ content })}
          onUploadImage={async (file) => (await uploadBlob(file)).url}
        />

        {error && <p class="form-error write__error" role="alert">{error}</p>}

        <div class="write__footer">
          <p class="write__count muted">
            {words} {words === 1 ? "word" : "words"} ·{" "}
            {readingTime(form.content)}
          </p>
          <p class="write__status muted" aria-live="polite">
            {dirty ? "Unsaved changes, kept in this browser." : ""}
          </p>
          <span class="rail__spacer" />
          <Button
            variant="secondary"
            loading={busy === "draft"}
            disabled={busy !== "" && busy !== "draft"}
            onClick={() => save("draft")}
          >
            Save draft
          </Button>
          <Button
            variant="primary"
            loading={busy === "publish"}
            disabled={busy !== "" && busy !== "publish"}
            onClick={() => save("publish")}
          >
            {published ? "Update" : "Publish"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The author's drafts, above a new article: open one, or delete it. */
function DraftList({ author }: { author: string }) {
  const [generation, setGeneration] = useState(0);
  const drafts = useAsync(() => fetchDrafts(author), [author, generation]);
  const rows: ArticleRow[] = drafts.data ?? [];
  if (rows.length === 0) return null;
  return (
    <section class="drafts" aria-labelledby="drafts-title">
      <h2 id="drafts-title" class="drafts__title">Drafts</h2>
      <ul class="drafts__list">
        {rows.map((row) => (
          <li key={row.naddr} class="draft-row">
            <Link class="draft-row__link" to={`/write/${row.naddr}`}>
              <span class="draft-row__title">{row.title}</span>
              <span class="muted">Saved {relativeTime(row.createdAt)}</span>
            </Link>
            <ConfirmButton
              label="Delete"
              question="Delete this draft?"
              onConfirm={async () => {
                await deleteAddress(row);
                setGeneration((n) => n + 1);
              }}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
