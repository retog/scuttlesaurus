/**
 * The Scuttlesaurus mark (a long-necked sauropod) and wordmark.
 *
 * @module
 */

/** The sauropod mark alone; draws in `currentColor`, scales with `size`. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      class="logo-mark"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <mask
        id="logo-eye"
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="64"
        height="64"
      >
        <rect width="64" height="64" fill="#fff" />
        <circle cx="20.5" cy="10.2" r="1.8" fill="#000" />
      </mask>
      <g fill="currentColor" mask="url(#logo-eye)">
        <ellipse cx="34" cy="42" rx="19" ry="11" />
        <path
          d="M23 40C15 36 17 24 17.5 17"
          fill="none"
          stroke="currentColor"
          stroke-width="8"
          stroke-linecap="round"
        />
        <ellipse
          cx="17.5"
          cy="11.5"
          rx="9.5"
          ry="5.6"
          transform="rotate(-14 17.5 11.5)"
        />
        <path
          d="M51 40C57 41 59.5 46 61 52"
          fill="none"
          stroke="currentColor"
          stroke-width="5"
          stroke-linecap="round"
        />
        <rect x="22" y="47" width="7.5" height="12" rx="3.5" />
        <rect x="40" y="47" width="7.5" height="12" rx="3.5" />
      </g>
    </svg>
  );
}

/** Mark plus the wordmark "Scuttlesaurus". */
export function Logo(
  { size = 28, word = true }: { size?: number; word?: boolean },
) {
  return (
    <span class="logo">
      <LogoMark size={size} />
      {word && <span class="logo__word rail-brand__word">Scuttlesaurus</span>}
    </span>
  );
}
