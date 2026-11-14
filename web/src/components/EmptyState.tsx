/**
 * Message for views without content, with an icon and optional action.
 *
 * @module
 */
import type { ComponentChildren } from "preact";

/** Props of {@link EmptyState}. */
export interface EmptyStateProps {
  title: string;
  /** Explanation under the title. */
  children?: ComponentChildren;
  icon?: ComponentChildren;
  action?: ComponentChildren;
  /** Visual tone: `error` colours the icon. */
  tone?: "neutral" | "error";
}

/** Centered "nothing here" message. */
export function EmptyState(
  { title, children, icon, action, tone = "neutral" }: EmptyStateProps,
) {
  return (
    <div class={`empty-state empty-state--${tone}`}>
      {icon && <div class="empty-state__icon" aria-hidden="true">{icon}</div>}
      <h2 class="empty-state__title">{title}</h2>
      {children && <p class="empty-state__text">{children}</p>}
      {action && <div class="empty-state__action">{action}</div>}
    </div>
  );
}
