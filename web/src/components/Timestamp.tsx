/**
 * A `<time>` element with relative text and the full date as tooltip.
 *
 * @module
 */
import { fullDate, relativeTime } from "../lib/format.ts";

/** Props of {@link Timestamp}. */
export interface TimestampProps {
  /** Unix seconds. */
  createdAt: number;
  /** Show the full date instead of the relative time. */
  full?: boolean;
}

/** Relative time ("3m", "Nov 3") with the full date in the tooltip. */
export function Timestamp({ createdAt, full }: TimestampProps) {
  return (
    <time
      class="timestamp"
      dateTime={new Date(createdAt * 1000).toISOString()}
      title={fullDate(createdAt)}
    >
      {full ? fullDate(createdAt) : relativeTime(createdAt)}
    </time>
  );
}
