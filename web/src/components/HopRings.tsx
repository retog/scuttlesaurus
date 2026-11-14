/**
 * Social distance drawn as concentric rings: you at the centre, then the people
 * you follow, then two hops out, up to the configured depth. Each ring carries
 * its number of authors, and the rings use the hop colours.
 *
 * @module
 */
import { formatCount } from "../lib/format.ts";
import { hopLabel } from "./HopBadge.tsx";

/** Props of {@link HopRings}. */
export interface HopRingsProps {
  /** Authors per distance; `counts[n]` is the number at n hops. */
  counts: readonly number[];
  /** The configured replication depth, in hops. */
  hops: number;
}

const SIZE = 240;
const OUTER = 112;

/** Concentric rings, outermost first, labelled with their author counts. */
export function HopRings({ counts, hops }: HopRingsProps) {
  const deepest = Math.max(hops, counts.length - 1, 0);
  const rings = Array.from({ length: deepest + 1 }, (_, hop) => ({
    hop,
    count: counts[hop] ?? 0,
    radius: OUTER * (hop + 1) / (deepest + 1),
  })).reverse();
  const centre = SIZE / 2;
  return (
    <figure class="hop-rings">
      <svg
        class="hop-rings__svg"
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label={`Authors by distance: ${
          rings
            .slice()
            .reverse()
            .map((r) => `${hopLabel(r.hop)} ${formatCount(r.count)}`)
            .join(", ")
        }`}
      >
        {rings.map((ring) => (
          <circle
            key={ring.hop}
            class={`hop-rings__ring hop-rings__ring--${Math.min(ring.hop, 3)}`}
            cx={centre}
            cy={centre}
            r={ring.radius}
          />
        ))}
        {rings.map((ring) => (
          <text
            key={`label-${ring.hop}`}
            class="hop-rings__count"
            x={centre}
            y={centre - ring.radius + 16}
            text-anchor="middle"
          >
            {formatCount(ring.count)}
          </text>
        ))}
        <text
          class="hop-rings__centre"
          x={centre}
          y={centre + 4}
          text-anchor="middle"
        >
          you
        </text>
      </svg>
    </figure>
  );
}
