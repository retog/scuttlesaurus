/**
 * Tabs: a row of buttons that select one of several values.
 *
 * @module
 */
import type { ComponentChildren } from "preact";

/** One tab. */
export interface TabItem<T extends string> {
  value: T;
  label: ComponentChildren;
  /** Optional count shown in a small pill. */
  count?: number;
}

/** Props of {@link Tabs}. */
export interface TabsProps<T extends string> {
  tabs: readonly TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name of the tab list. */
  label: string;
}

/** Tab strip with arrow-key navigation. The panel is the caller's business. */
export function Tabs<T extends string>(
  { tabs, value, onChange, label }: TabsProps<T>,
) {
  const onKeyDown = (event: KeyboardEvent) => {
    const index = tabs.findIndex((t) => t.value === value);
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") {
      next = (index - 1 + tabs.length) % tabs.length;
    } else return;
    event.preventDefault();
    onChange(tabs[next].value);
    const list = event.currentTarget as HTMLElement;
    queueMicrotask(() =>
      list.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus()
    );
  };
  return (
    <div class="tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((tab) => (
        <button
          key={tab.value}
          class="tabs__tab"
          type="button"
          role="tab"
          aria-selected={tab.value === value}
          tabIndex={tab.value === value ? 0 : -1}
          onClick={() => onChange(tab.value)}
        >
          {tab.label}
          {tab.count !== undefined && (
            <span class="tabs__count">{tab.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}
