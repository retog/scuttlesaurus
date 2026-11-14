/**
 * Loading indicators: {@link Spinner} and shaped {@link Skeleton}s.
 *
 * @module
 */

/** A small spinning ring with an accessible label. */
export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span class="spinner" role="status">
      <span class="visually-hidden">{label}</span>
    </span>
  );
}

/** Props of {@link Skeleton}. */
export interface SkeletonProps {
  /** `line` (default) text lines, `note` a note card, `article` an article card. */
  shape?: "line" | "note" | "article" | "avatar";
  /** Number of repetitions. */
  count?: number;
}

/** Placeholder shapes shown while content loads. */
export function Skeleton({ shape = "line", count = 1 }: SkeletonProps) {
  const items = Array.from({ length: count }, (_, i) => i);
  if (shape === "note") {
    return (
      <div class="stack" aria-busy="true" aria-label="Loading notes">
        {items.map((i) => (
          <div class="card skeleton-note" key={i}>
            <span class="skeleton skeleton--circle" />
            <div class="skeleton-note__body">
              <span class="skeleton skeleton--line" style={{ width: "35%" }} />
              <span class="skeleton skeleton--line" />
              <span class="skeleton skeleton--line" style={{ width: "80%" }} />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (shape === "article") {
    return (
      <div class="stack" aria-busy="true" aria-label="Loading articles">
        {items.map((i) => (
          <div class="card skeleton-article" key={i}>
            <span class="skeleton skeleton--cover" />
            <div class="skeleton-note__body">
              <span
                class="skeleton skeleton--line"
                style={{ width: "70%", height: "20px" }}
              />
              <span class="skeleton skeleton--line" />
              <span class="skeleton skeleton--line" style={{ width: "50%" }} />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (shape === "avatar") return <span class="skeleton skeleton--circle" />;
  return (
    <div class="stack" aria-busy="true">
      {items.map((i) => (
        <span
          class="skeleton skeleton--line"
          key={i}
          style={{
            width: i === items.length - 1 && count > 1 ? "60%" : "100%",
          }}
        />
      ))}
    </div>
  );
}
