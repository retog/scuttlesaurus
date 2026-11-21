/**
 * An endless list of notes: pages of {@link NoteRow}s rendered as
 * {@link NoteItem}s (counts, like / repost / reply / delete wired), loaded as
 * the reader scrolls. The Home, Search and Profile views use it.
 *
 * @module
 */
import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { hiddenNotes, loadStats } from "../lib/actions.ts";
import type { NoteRow } from "../lib/feed.ts";
import { NoteItem } from "./NoteItem.tsx";
import { PagedList } from "./PagedList.tsx";

/** Props of {@link NoteFeed}. */
export interface NoteFeedProps {
  /**
   * Loads one page, newest first: no argument for the first page, then the
   * `at` of the last note received (an inclusive upper bound, so a note may be
   * delivered twice; the feed drops duplicates). Use the functions of
   * `lib/feed.ts`, e.g. `(until) => fetchAuthorNotes({ author, withReplies: false, until })`.
   * A rejection shows an error with a retry button.
   */
  load: (until?: number) => Promise<NoteRow[]>;
  /** Changing the key empties the feed and loads the first page again. */
  resetKey: string | number;
  /** Shown when there are no notes at all (an `EmptyState`, usually). */
  empty: ComponentChildren;
  /**
   * The number of notes `load` returns for a full page (default 20, the
   * default of the `lib/feed.ts` functions). A shorter page ends the feed.
   */
  pageSize?: number;
  /** Notes to show above the loaded ones, e.g. the viewer's new post. */
  prepend?: readonly NoteRow[];
}

const hidden = (note: NoteRow) =>
  hiddenNotes.value.has(note.id) ||
  (note.repostedBy !== undefined && hiddenNotes.value.has(note.repostedBy.id));

/**
 * Infinite feed of notes. The next page is requested when the end of the list
 * nears the viewport (a "Load more" button is the fallback), skeletons show
 * while loading, and a failed page shows a compact error with retry.
 */
export function NoteFeed(props: NoteFeedProps) {
  const { load, resetKey, empty, pageSize, prepend } = props;
  const added = prepend?.map((n) => n.id).join(",");
  useEffect(() => {
    if (prepend?.length) void loadStats(prepend.map((n) => n.id));
  }, [added]);
  return (
    <PagedList<NoteRow>
      load={load}
      resetKey={resetKey}
      empty={empty}
      pageSize={pageSize}
      prepend={prepend}
      keyOf={(note) => note.key}
      cursorOf={(note) => note.at}
      hidden={hidden}
      render={(note) => <NoteItem note={note} />}
      onPage={(rows) => void loadStats(rows.map((n) => n.id))}
      class="note-feed"
    />
  );
}
