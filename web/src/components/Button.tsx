/**
 * Buttons: a pill {@link Button} and a round {@link IconButton}.
 *
 * @module
 */
import type { ComponentChildren } from "preact";
import { Link } from "../lib/router.tsx";

/** Props of {@link Button}. */
export interface ButtonProps {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  /** Renders a link (in-app navigation) instead of a button. */
  to?: string;
  type?: "button" | "submit";
  disabled?: boolean;
  loading?: boolean;
  /** Icon element placed before the label. */
  icon?: ComponentChildren;
  class?: string;
  title?: string;
  onClick?: (event: MouseEvent) => void;
  children?: ComponentChildren;
}

/** Pill button. */
export function Button(props: ButtonProps) {
  const {
    variant = "secondary",
    size = "md",
    to,
    type = "button",
    disabled,
    loading,
    icon,
    children,
    onClick,
    title,
  } = props;
  const cls = `btn btn--${variant} btn--${size}${
    props.class ? " " + props.class : ""
  }`;
  const inner = (
    <>
      {icon && <span class="btn__icon" aria-hidden="true">{icon}</span>}
      <span class="btn__label">{children}</span>
    </>
  );
  if (to && !disabled) {
    return <Link class={cls} to={to} title={title}>{inner}</Link>;
  }
  return (
    <button
      class={cls}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      title={title}
      onClick={onClick as ((e: Event) => void) | undefined}
    >
      {loading
        ? <span class="spinner spinner--inline" aria-hidden="true" />
        : inner}
    </button>
  );
}

/** Props of {@link IconButton}. */
export interface IconButtonProps {
  /** Required: icon-only buttons need an accessible name. */
  label: string;
  icon: ComponentChildren;
  variant?: "ghost" | "primary" | "danger";
  size?: "sm" | "md";
  /** Highlights the button (e.g. a liked heart). */
  active?: boolean;
  disabled?: boolean;
  to?: string;
  class?: string;
  /** Optional count shown after the icon. */
  count?: number | string;
  onClick?: (event: MouseEvent) => void;
}

/** Round (or pill, with a count) icon-only button with an `aria-label`. */
export function IconButton(props: IconButtonProps) {
  const {
    label,
    icon,
    variant = "ghost",
    size = "md",
    active,
    disabled,
    to,
    count,
  } = props;
  const cls = `icon-btn icon-btn--${variant} icon-btn--${size}${
    active ? " is-active" : ""
  }${props.class ? " " + props.class : ""}`;
  const inner = (
    <>
      {icon}
      {count !== undefined && count !== "" && (
        <span class="icon-btn__count">{count}</span>
      )}
    </>
  );
  if (to) {
    return (
      <Link class={cls} to={to} aria-label={label} title={label}>{inner}</Link>
    );
  }
  return (
    <button
      class={cls}
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled}
      onClick={props.onClick as ((e: Event) => void) | undefined}
    >
      {inner}
    </button>
  );
}
