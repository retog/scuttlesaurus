/**
 * The share target of the installed app (`/share`): what another app shared,
 * a link above all, becomes the draft of a new note. A shared Nostr reference
 * can also be opened here, and shared images and videos are uploaded and
 * attached. Without a share it is a plain "new note" page, which the app's
 * "New note" shortcut opens.
 *
 * @module
 */
import { ArrowRight, Link2 } from "lucide-preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { Button } from "../components/Button.tsx";
import { Composer } from "../components/Composer.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { toast } from "../components/Toast.tsx";
import { submitNote } from "../lib/actions.ts";
import { useDocumentTitle } from "../lib/hooks.ts";
import { notePath } from "../lib/nostr.ts";
import { navigate, useRoute } from "../lib/router.tsx";
import {
  composeShared,
  sharedFromQuery,
  sharedLink,
  sharedNostrPath,
  takeSharedFiles,
} from "../lib/share.ts";

/** The share view. */
export default function ShareView() {
  const route = useRoute();
  const shared = useMemo(() => sharedFromQuery(route.query), [route.query]);
  const draft = useMemo(() => composeShared(shared), [shared]);
  const link = sharedLink(shared);
  const nostrPath = sharedNostrPath(shared);
  const fileCount = route.query.get("files");
  const [files, setFiles] = useState<File[]>();
  const hasShare = draft !== "" || fileCount !== null;
  useDocumentTitle(hasShare ? "Share" : "New note");

  useEffect(() => {
    if (fileCount && fileCount !== "dropped") takeSharedFiles().then(setFiles);
  }, [fileCount]);

  return (
    <div class="page share">
      <PageHeader
        title={hasShare ? "Share as a note" : "New note"}
        subtitle={link ? <SharedLink href={link} /> : undefined}
      />
      {nostrPath && (
        <div class="card share__nostr">
          <p>This share points to something on Nostr.</p>
          <Button
            size="sm"
            variant="secondary"
            icon={<ArrowRight size={16} />}
            to={nostrPath}
          >
            Open it here
          </Button>
        </div>
      )}
      {fileCount === "dropped" && (
        <p class="share__notice muted" role="status">
          The shared files did not arrive. Open the app once while online, then
          share them again.
        </p>
      )}
      <div class="card share__compose">
        <Composer
          autoFocus
          initialValue={draft}
          initialFiles={files}
          placeholder="What is on your mind?"
          submitLabel="Post"
          onCancel={() => navigate("/", { replace: true })}
          onSubmit={async (content) => {
            const event = await submitNote(content);
            toast("Note published", "success");
            navigate(notePath(event.id), { replace: true });
          }}
        />
      </div>
    </div>
  );
}

/** The shared link, shortened to its host and path. */
function SharedLink({ href }: { href: string }) {
  let label = href;
  try {
    const url = new URL(href);
    label = url.host + (url.pathname === "/" ? "" : url.pathname);
  } catch {
    // not a URL after all; show it as it is
  }
  return (
    <a
      class="share__link"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      <Link2 size={14} aria-hidden="true" />
      <span>{label}</span>
    </a>
  );
}
