/**
 * Light/dark toggle (persisted).
 *
 * @module
 */
import { Moon, Sun } from "lucide-preact";
import { theme, toggleTheme } from "../lib/theme.ts";
import { IconButton } from "./Button.tsx";

/** Button that switches between the light and dark theme. */
export function ThemeToggle() {
  const dark = theme.value === "dark";
  return (
    <IconButton
      label={dark ? "Switch to light theme" : "Switch to dark theme"}
      icon={dark ? <Sun size={20} /> : <Moon size={20} />}
      onClick={toggleTheme}
    />
  );
}
