/**
 * Profile picture, or a deterministic two-tone gradient from the pubkey with
 * the first letter of the name.
 *
 * @module
 */
import { User } from "lucide-preact";
import { useState } from "preact/hooks";
import { displayNameOf, useProfile } from "../lib/profiles.ts";

/** The gradient background for a pubkey (stable across sessions). */
export function gradientFor(pubkey: string): string {
  const a = parseInt(pubkey.slice(0, 4), 16) % 360;
  const b = (a + 40 + (parseInt(pubkey.slice(4, 6), 16) % 70)) % 360;
  return `linear-gradient(135deg, hsl(${a} 52% 42%), hsl(${b} 58% 34%))`;
}

/** Props of {@link Avatar}. */
export interface AvatarProps {
  pubkey: string;
  /** Pixel size (default 40). */
  size?: number;
  /** Overrides the profile lookup. */
  picture?: string;
  name?: string;
}

/** Avatar for an author; loads the profile itself unless given values. */
export function Avatar({ pubkey, size = 40, picture, name }: AvatarProps) {
  const profile = useProfile(pubkey);
  const [broken, setBroken] = useState(false);
  const src = picture ?? profile.picture;
  const label = name ?? displayNameOf(profile, pubkey);
  const named = Boolean((name ?? profile.displayName ?? profile.name)?.trim());
  const letter = named
    ? label.match(/\p{L}|\p{N}/u)?.[0]?.toUpperCase()
    : undefined;
  const style = {
    width: `${size}px`,
    height: `${size}px`,
    fontSize: `${size * 0.42}px`,
  };
  if (src && !broken) {
    return (
      <img
        class="avatar"
        style={style}
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <span
      class="avatar avatar--letter"
      style={{ ...style, background: gradientFor(pubkey) }}
      aria-hidden="true"
    >
      {letter ?? <User size={size * 0.5} />}
    </span>
  );
}
