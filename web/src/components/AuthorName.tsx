/**
 * An author's name with NIP-05 and social distance, linking to the profile.
 *
 * @module
 */
import { distanceOf } from "../lib/node.ts";
import { profilePath } from "../lib/nostr.ts";
import { displayNameOf, useProfile } from "../lib/profiles.ts";
import { Link } from "../lib/router.tsx";
import { session } from "../lib/session.ts";
import { HopBadge } from "./HopBadge.tsx";

/** Props of {@link AuthorName}. */
export interface AuthorNameProps {
  pubkey: string;
  /** Show the NIP-05 identifier after the name (default true). */
  showNip05?: boolean;
  /** Show the hop badge (default true). */
  showHops?: boolean;
  /** Render as plain text instead of a link. */
  plain?: boolean;
}

/** Name, NIP-05 and hop badge for a pubkey. */
export function AuthorName(
  { pubkey, showNip05 = true, showHops = true, plain }: AuthorNameProps,
) {
  const profile = useProfile(pubkey);
  const name = displayNameOf(profile, pubkey);
  const mine = session.value?.pubkey === pubkey;
  const hops = mine ? 0 : distanceOf(pubkey);
  const nip05 = profile.nip05?.replace(/^_@/, "");
  return (
    <span class="author-name">
      {plain
        ? <span class="author-name__name">{name}</span>
        : (
          <Link class="author-name__name" to={profilePath(pubkey)}>
            {name}
          </Link>
        )}
      {showNip05 && nip05 && <span class="author-name__nip05">{nip05}</span>}
      {showHops && hops !== undefined && (
        <HopBadge hops={hops} owner={hops === 0 && !mine} />
      )}
    </span>
  );
}
