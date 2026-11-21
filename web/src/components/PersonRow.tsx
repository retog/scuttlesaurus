/**
 * A person as a row: avatar, name, NIP-05, a line of their bio and, for
 * suggestions, which of the viewer's follows follow them. The whole row opens
 * the profile.
 *
 * @module
 */
import { distanceOf } from "../lib/node.ts";
import { profilePath } from "../lib/nostr.ts";
import { displayNameOf, useProfile } from "../lib/profiles.ts";
import { navigate } from "../lib/router.tsx";
import { AuthorName } from "./AuthorName.tsx";
import { Avatar } from "./Avatar.tsx";

/** Props of {@link PersonRow}. */
export interface PersonRowProps {
  /** Hex pubkey. */
  pubkey: string;
  /** Hex pubkeys of people who lead to this person ("Followed by …"). */
  via?: readonly string[];
  /** Mark a person nothing is known about as "not in your habitat yet". */
  flagUnknown?: boolean;
}

function Via({ people }: { people: readonly string[] }) {
  const first = people.slice(0, 2);
  const rest = people.length - first.length;
  return (
    <p class="person-row__via muted">
      Followed by {first.map((pubkey, i) => (
        <span key={pubkey}>
          {i > 0 ? (rest > 0 ? ", " : " and ") : ""}
          <NameOnly pubkey={pubkey} />
        </span>
      ))}
      {rest > 0 && ` and ${rest} ${rest === 1 ? "other" : "others"} you follow`}
    </p>
  );
}

function NameOnly({ pubkey }: { pubkey: string }) {
  return <>{displayNameOf(useProfile(pubkey), pubkey)}</>;
}

/** A row for one person. */
export function PersonRow({ pubkey, via, flagUnknown }: PersonRowProps) {
  const profile = useProfile(pubkey);
  const unknown = flagUnknown && profile.loaded &&
    !profile.name && !profile.displayName && !profile.about &&
    distanceOf(pubkey) === undefined;
  return (
    <article
      class="card person-row"
      onClick={(event) => {
        if ((event.target as Element).closest("a, button")) return;
        navigate(profilePath(pubkey));
      }}
    >
      <Avatar pubkey={pubkey} size={44} />
      <div class="person-row__body">
        <AuthorName pubkey={pubkey} />
        {unknown && (
          <p class="person-row__note muted">
            Not in your habitat yet. This node has no profile for them.
          </p>
        )}
        {profile.about && (
          <p class="person-row__about">{profile.about.slice(0, 200)}</p>
        )}
        {via && via.length > 0 && <Via people={via} />}
      </div>
    </article>
  );
}
