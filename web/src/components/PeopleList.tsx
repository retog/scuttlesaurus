/**
 * A paged list of people for the Following and Followers tabs. The list is
 * read once; the order is decided here: people inside the habitat first (the
 * closest first), then, when `grouped`, the rest under a "Not in your habitat"
 * heading. Paging happens over the sorted list.
 *
 * @module
 */
import { distanceOf, graph } from "../lib/node.ts";
import type { PersonRef } from "../lib/people.ts";
import { useAsync } from "../lib/hooks.ts";
import { EmptyState } from "./EmptyState.tsx";
import { PagedList } from "./PagedList.tsx";
import { PersonRow } from "./PersonRow.tsx";
import { Skeleton } from "./Spinner.tsx";

/** Props of {@link PeopleList}. */
export interface PeopleListProps {
  /** Changing this reads the list again. */
  resetKey: string;
  /** Reads the people; the list is shown when this resolves. */
  load: () => Promise<PersonRef[]>;
  /** Show the in-habitat and not-in-habitat groups (for follow lists). */
  grouped?: boolean;
  /** Shown when there is nobody. */
  empty: { title: string; text: string };
}

const PAGE = 20;

interface Row {
  pubkey: string;
  /** Position in the sorted list (the paging cursor is this plus one). */
  index: number;
  outside: boolean;
  heading?: string;
}

function rowsOf(people: readonly PersonRef[], grouped: boolean): Row[] {
  const inside = (p: PersonRef) => distanceOf(p.pubkey) !== undefined;
  const order = (a: PersonRef, b: PersonRef) =>
    (distanceOf(a.pubkey) ?? 99) - (distanceOf(b.pubkey) ?? 99) ||
    (a.label || "￿").localeCompare(b.label || "￿");
  const near = people.filter(inside).sort(order);
  const far = people.filter((p) => !inside(p)).sort(order);
  const rows: Row[] = [];
  const add = (list: PersonRef[], outside: boolean, heading?: string) =>
    list.forEach((p, i) => {
      rows.push({
        pubkey: p.pubkey,
        index: rows.length,
        outside,
        heading: i === 0 ? heading : undefined,
      });
    });
  if (grouped && near.length > 0 && far.length > 0) {
    add(near, false, "In your habitat");
    add(far, true, "Not in your habitat");
  } else if (grouped && far.length > 0) {
    add(far, true, "Not in your habitat");
  } else {
    add(near, false);
    add(far, true);
  }
  return rows;
}

/** A paged list of people; see the module comment. */
export function PeopleList(
  { resetKey, load, grouped = false, empty }: PeopleListProps,
) {
  const list = useAsync(load, [resetKey]);
  // The graph arrives after the first render; the order depends on it.
  const graphKey = graph.value ? "graph" : "no-graph";
  if (list.error) {
    return (
      <EmptyState tone="error" title="Could not load these people">
        {list.error.message}
      </EmptyState>
    );
  }
  if (!list.data) return <Skeleton shape="line" count={4} />;
  const rows = rowsOf(list.data, grouped);
  if (rows.length === 0) {
    return <EmptyState title={empty.title}>{empty.text}</EmptyState>;
  }
  return (
    <PagedList<Row>
      resetKey={`${resetKey}|${graphKey}`}
      pageSize={PAGE}
      load={(cursor) => {
        const start = cursor ?? 0;
        return Promise.resolve(rows.slice(start, start + PAGE));
      }}
      cursorOf={(row) => row.index + 1}
      keyOf={(row) => row.pubkey}
      render={(row) => (
        <>
          {row.heading && <h2 class="people-list__heading">{row.heading}</h2>}
          <PersonRow pubkey={row.pubkey} flagUnknown={row.outside} />
        </>
      )}
      empty={<EmptyState title={empty.title}>{empty.text}</EmptyState>}
      class="people-list"
    />
  );
}
