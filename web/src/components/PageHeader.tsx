/**
 * Title row at the top of a view.
 *
 * @module
 */
import type { ComponentChildren } from "preact";

/** Props of {@link PageHeader}. */
export interface PageHeaderProps {
  title: ComponentChildren;
  subtitle?: ComponentChildren;
  /** Buttons aligned to the right. */
  actions?: ComponentChildren;
}

/** `<header>` with a title, optional subtitle and actions. */
export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <header class="page-header">
      <div>
        <h1 class="page-header__title">{title}</h1>
        {subtitle && <p class="page-header__sub">{subtitle}</p>}
      </div>
      {actions && <div class="page-header__actions">{actions}</div>}
    </header>
  );
}
