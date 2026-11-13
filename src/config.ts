/**
 * Configuration loading and runtime updates. Contract: `docs/ARCHITECTURE.md`.
 * @module
 */
import type { ConfigManager } from "./types.ts";

/**
 * Build the effective configuration from defaults, `<dataDir>/config.json`
 * and the given environment (defaults to the process environment).
 */
export function loadConfig(
  _env?: Record<string, string | undefined>,
): Promise<ConfigManager> {
  throw new Error("not implemented");
}
