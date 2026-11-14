/**
 * Generated images for the seed world: avatars, banners and illustrations, in
 * the flat palette of `web/static/assets/tokens.css` and the look of the
 * component gallery fixtures.
 * @module
 */
import type { AvatarLook, Motif } from "./model.ts";
import type { Rng } from "./random.ts";

/** Colours from the design tokens. */
export const INK = {
  paper: "#f6f4ee",
  primary: "#1f7a5c",
  primarySoft: "#dff0e8",
  accent: "#d98a1f",
  teal: "#0f8a8a",
  plum: "#7a6f9b",
  sand: "#f3d9a4",
  night: "#16382c",
  moss: "#4cc79a",
  navy: "#2b2f4a",
  gold: "#f0b254",
  clay: "#c2410c",
} as const;

/** Background and foreground pairs for avatars. */
export const AVATAR_PAIRS: readonly (readonly [string, string])[] = [
  [INK.primarySoft, INK.primary],
  [INK.navy, INK.gold],
  [INK.sand, INK.accent],
  [INK.paper, INK.teal],
  [INK.night, INK.moss],
  [INK.paper, INK.plum],
];

/** The motifs an avatar can take. */
export const MOTIFS: readonly Motif[] = [
  "figure",
  "crescent",
  "sun",
  "leaf",
  "waves",
  "hill",
];

/** The look of an avatar: a motif on a background pair, chosen by `index`. */
export function avatarLook(motif: Motif, index: number): AvatarLook {
  const [background, foreground] = AVATAR_PAIRS[index % AVATAR_PAIRS.length];
  return { motif, background, foreground };
}

/** A square avatar (160 x 160). */
export function avatarSvg(look: AvatarLook): string {
  const { background: bg, foreground: fg } = look;
  const body = {
    figure:
      `<circle cx="80" cy="64" r="30" fill="${fg}"/><path d="M24 160 C28 112 132 112 136 160Z" fill="${fg}"/>`,
    crescent:
      `<circle cx="80" cy="80" r="44" fill="${fg}"/><circle cx="96" cy="68" r="38" fill="${bg}"/>`,
    sun:
      `<circle cx="80" cy="84" r="34" fill="${fg}"/><path d="M0 120 H160 V160 H0Z" fill="${fg}" opacity=".35"/>`,
    leaf:
      `<path d="M40 128 C40 60 110 36 128 40 C128 110 90 132 40 128Z" fill="${fg}"/><path d="M40 128 L100 70" stroke="${bg}" stroke-width="5"/>`,
    waves:
      `<path d="M0 88 Q20 72 40 88 T80 88 T120 88 T160 88 V160 H0Z" fill="${fg}"/><path d="M0 116 Q20 100 40 116 T80 116 T120 116 T160 116 V160 H0Z" fill="${fg}" opacity=".6"/>`,
    hill:
      `<circle cx="112" cy="46" r="20" fill="${fg}" opacity=".9"/><path d="M0 130 C40 80 90 80 160 130 V160 H0Z" fill="${fg}"/>`,
  }[look.motif];
  return svgDocument(
    160,
    160,
    `<rect width="160" height="160" fill="${bg}"/>${body}`,
  );
}

/** A banner (800 x 200): hills under a sun, in two greens. */
export function bannerSvg(rng: Rng): string {
  const sunX = rng.int(120, 680);
  return svgDocument(
    800,
    200,
    `<rect width="800" height="200" fill="${INK.sand}"/>` +
      `<circle cx="${sunX}" cy="62" r="34" fill="${INK.accent}" opacity=".85"/>` +
      `<path d="M0 130 C150 90 260 150 380 118 S640 96 800 140 V200 H0Z" fill="${INK.moss}"/>` +
      `<path d="M0 166 C170 134 300 182 470 156 S700 140 800 170 V200 H0Z" fill="${INK.primary}"/>`,
  );
}

/** A landscape illustration (800 x 420) in one of four scenes. */
export function illustrationSvg(rng: Rng): string {
  const scene = rng.pick(["hills", "ferns", "tide", "leaves"] as const);
  const sunX = rng.int(80, 720);
  const sunY = rng.int(70, 150);
  if (scene === "ferns") {
    const stems = [0, 1, 2, 3].map((i) => {
      const x = 90 + i * 190 + rng.int(-30, 30);
      const top = rng.int(120, 240);
      return `<path d="M${x} 420 C${x + 20} 300 ${x + 70} ${top + 60} ${
        x + 180
      } ${top}" stroke="${INK.moss}" stroke-width="6" fill="none" stroke-linecap="round" opacity=".9"/>`;
    });
    return svgDocument(
      800,
      420,
      `<rect width="800" height="420" fill="${INK.night}"/>${stems.join("")}` +
        `<circle cx="${sunX}" cy="${sunY}" r="28" fill="${INK.gold}"/>`,
    );
  }
  if (scene === "tide") {
    return svgDocument(
      800,
      420,
      `<rect width="800" height="420" fill="${INK.paper}"/>` +
        `<circle cx="${sunX}" cy="${sunY}" r="46" fill="${INK.accent}" opacity=".8"/>` +
        `<path d="M0 230 Q50 200 100 230 T200 230 T300 230 T400 230 T500 230 T600 230 T700 230 T800 230 V420 H0Z" fill="${INK.teal}" opacity=".55"/>` +
        `<path d="M0 290 Q50 262 100 290 T200 290 T300 290 T400 290 T500 290 T600 290 T700 290 T800 290 V420 H0Z" fill="${INK.primary}"/>`,
    );
  }
  if (scene === "leaves") {
    const leaves = Array.from({ length: 7 }, (_, i) => {
      const x = rng.int(60, 740);
      const y = rng.int(60, 360);
      const angle = rng.int(-60, 60);
      return `<path transform="translate(${x} ${y}) rotate(${angle})" d="M0 0 C40 -50 110 -40 130 0 C110 40 40 50 0 0Z" fill="${
        i % 2 ? INK.primary : INK.moss
      }" opacity=".85"/>`;
    });
    return svgDocument(
      800,
      420,
      `<rect width="800" height="420" fill="${INK.primarySoft}"/>${
        leaves.join("")
      }`,
    );
  }
  return svgDocument(
    800,
    420,
    `<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${INK.sand}"/><stop offset="1" stop-color="${INK.paper}"/></linearGradient></defs>` +
      `<rect width="800" height="420" fill="url(#s)"/>` +
      `<circle cx="${sunX}" cy="${sunY}" r="54" fill="${INK.accent}" opacity=".85"/>` +
      `<path d="M0 300 C120 220 220 260 320 230 S520 180 800 270 V420 H0Z" fill="${INK.moss}"/>` +
      `<path d="M0 350 C140 290 260 330 400 300 S640 270 800 340 V420 H0Z" fill="${INK.primary}"/>`,
  );
}

function svgDocument(width: number, height: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}
