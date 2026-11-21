/**
 * A QR code drawn as inline SVG with `uqr` (dependency-free, about 5 KB).
 *
 * The code is always black on a white plate, in both themes: scanners need
 * dark modules on a light background, so the plate does not follow the theme
 * (see `.qr` in `components.css`).
 *
 * @module
 */
import { renderSVG } from "uqr";

/** Props of {@link QrCode}. */
export interface QrCodeProps {
  /** The text to encode. */
  value: string;
  /** Accessible description. */
  label: string;
}

/** The QR code of `value`, with a four-module quiet zone. */
export function QrCode({ value, label }: QrCodeProps) {
  // Low error correction keeps a long nostrconnect:// link to a coarser grid
  // that a phone camera reads more easily from a monitor.
  const svg = renderSVG(value, {
    ecc: "L",
    border: 4,
    blackColor: "#000000",
    whiteColor: "#ffffff",
  });
  return (
    <div
      class="qr"
      role="img"
      aria-label={label}
      // The markup comes from the library, not from user input.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
