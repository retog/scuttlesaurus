/**
 * Small hooks shared by the views.
 *
 * @module
 */
import { useCallback, useEffect, useRef, useState } from "preact/hooks";

/** State of an {@link useAsync} call. */
export interface AsyncState<T> {
  /** The latest successful result (kept while reloading). */
  data: T | undefined;
  /** The error of the latest attempt, if it failed. */
  error: Error | undefined;
  /** True while a request is in flight. */
  loading: boolean;
  /** Run the function again. */
  reload: () => void;
}

/**
 * Run an async function when `deps` change. Results of superseded calls are
 * discarded; the `AbortSignal` passed to `fn` is aborted when that happens
 * and when the component unmounts.
 */
export function useAsync<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): AsyncState<T> {
  const [state, setState] = useState<
    { data?: T; error?: Error; loading: boolean }
  >({ loading: true });
  const [nonce, setNonce] = useState(0);
  const latest = useRef(fn);
  latest.current = fn;

  useEffect(() => {
    const controller = new AbortController();
    setState((s) => ({ data: s.data, loading: true }));
    latest.current(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ data, loading: false });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState((s) => ({
          data: s.data,
          error: error instanceof Error ? error : new Error(String(error)),
          loading: false,
        }));
      },
    );
    return () => controller.abort();
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return {
    data: state.data,
    error: state.error,
    loading: state.loading,
    reload,
  };
}

/** Set `document.title` (suffixed with the app name) while mounted. */
export function useDocumentTitle(title: string | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · Scuttlesaurus` : "Scuttlesaurus";
  }, [title]);
}

/** A value that follows `value` after it has been stable for `ms`. */
export function useDebounced<T>(value: T, ms = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}
