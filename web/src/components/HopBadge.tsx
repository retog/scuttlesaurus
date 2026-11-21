/**
 * Social distance as a small badge: a coloured dot and a label.
 *
 * @module
 */

/** Label for a hop distance: "you", "following", "2 hops", "3 hops". */
export function hopLabel(hops: number, owner = false): string {
  if (hops === 0) return owner ? "owner" : "you";
  if (hops === 1) return "following";
  return `${hops} hops`;
}

/** Props of {@link HopBadge}. */
export interface HopBadgeProps {
  /** Distance from the owner (0 = you). */
  hops: number;
  /** For hop 0: label it "owner" instead of "you" (when you are not them). */
  owner?: boolean;
}

/** The dot colours: 0 primary, 1 teal, 2 amber, 3+ violet. */
export function HopBadge({ hops, owner }: HopBadgeProps) {
  const level = Math.min(hops, 3);
  const label = hopLabel(hops, owner);
  return (
    <span class="hop-badge" title={`Social distance: ${label}`}>
      <span
        class={`hop-badge__dot hop-badge__dot--${level}`}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}
