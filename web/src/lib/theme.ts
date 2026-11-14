/**
 * Light/dark theme. Follows `prefers-color-scheme` until the user toggles,
 * after which the choice is stored in localStorage and applied as
 * `data-theme` on `<html>` (`index.html` applies it before first paint).
 *
 * @module
 */
import { computed, signal } from "@preact/signals";

const KEY = "scuttlesaurus.theme";

export type Theme = "light" | "dark";

function stored(): Theme | undefined {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : undefined;
  } catch {
    return undefined;
  }
}

const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");

/** The user's explicit choice, or undefined to follow the system. */
export const themeChoice = signal<Theme | undefined>(stored());
const systemDark = signal(media?.matches ?? false);
media?.addEventListener("change", (e) => systemDark.value = e.matches);

/** The theme currently in effect. */
export const theme = computed<Theme>(() =>
  themeChoice.value ?? (systemDark.value ? "dark" : "light")
);

/** Make the choice explicit, persist it and apply it. */
export function setTheme(next: Theme): void {
  themeChoice.value = next;
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // storage unavailable: the choice lasts for this page view
  }
}

/** Switch to the opposite of the theme currently in effect. */
export function toggleTheme(): void {
  setTheme(theme.value === "dark" ? "light" : "dark");
}
