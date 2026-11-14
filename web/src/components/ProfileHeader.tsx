/**
 * The top of a profile: banner, avatar, name, NIP-05, the social distance
 * ("you", "owner", "following", "2 hops" or "outside your habitat"), the bio,
 * the website, the npub with a copy button, the counts, and who among the
 * viewer's follows follows this person. The actions are the follow button, or
 * "Edit profile" on the viewer's own profile.
 *
 * @module
 */
import { Copy, Globe, Pencil } from "lucide-preact";
import { useState } from "preact/hooks";
import { type ProfileStats } from "../lib/people.ts";
import { formatCount } from "../lib/format.ts";
import { hopLabel } from "./HopBadge.tsx";
import { copyText } from "./LoginDialog.tsx";
import { EditProfileDialog } from "./EditProfileDialog.tsx";
import { FollowButton } from "./FollowButton.tsx";
import { Avatar, gradientFor } from "./Avatar.tsx";
import { Button, IconButton } from "./Button.tsx";
import { NoteContent } from "./NoteContent.tsx";
import { profilePath, shortNpub, toNpub } from "../lib/nostr.ts";
import { displayNameOf, type Profile, useProfile } from "../lib/profiles.ts";
import { Link } from "../lib/router.tsx";
import { canSign } from "../lib/session.ts";
import { openLogin } from "../lib/ui.ts";

/** The tabs a profile can show; the counts link to some of them. */
export type ProfileTab =
  | "notes"
  | "replies"
  | "articles"
  | "following"
  | "followers";

/** Props of {@link ProfileHeader}. */
export interface ProfileHeaderProps {
  pubkey: string;
  profile: Profile;
  /** Hex pubkey of the signed-in person, if any. */
  viewer: string | null;
  /** Social distance from the owner; `undefined` outside the habitat. */
  hops: number | undefined;
  /** Counts, or `undefined` while they load. */
  stats: ProfileStats | undefined;
  /** Whether the counts failed to load. */
  statsFailed: boolean;
  /** Viewer's follows who follow this person; `undefined` while loading. */
  followedBy: readonly string[] | undefined;
  onTab: (tab: ProfileTab) => void;
  /** Called after a follow change, so that counts are read again. */
  onChanged: () => void;
}

/** The website as a link target, if it is an http or https address. */
function websiteUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

/** The distance as a pill: "you", "following", "2 hops", or "outside your habitat". */
function Standing(
  { hops, isMine }: { hops: number | undefined; isMine: boolean },
) {
  if (hops === undefined) {
    return (
      <p class="profile-standing profile-standing--outside">
        <span class="profile-standing__dot" aria-hidden="true" />
        outside your habitat
      </p>
    );
  }
  const owner = hops === 0 && !isMine;
  return (
    <p
      class={`profile-standing profile-standing--${Math.min(hops, 3)}`}
      title={`Social distance: ${hopLabel(hops, owner)}`}
    >
      <span class="profile-standing__dot" aria-hidden="true" />
      {hopLabel(hops, owner)}
    </p>
  );
}

function NameOf({ pubkey }: { pubkey: string }) {
  return <>{displayNameOf(useProfile(pubkey), pubkey)}</>;
}

function FollowedBy({ pubkeys }: { pubkeys: readonly string[] }) {
  const shown = pubkeys.slice(0, 2);
  const rest = pubkeys.length - shown.length;
  return (
    <>
      Followed by {shown.map((pubkey, i) => (
        <span key={pubkey}>
          {i > 0 && (rest > 0 ? ", " : " and ")}
          <Link class="profile-header__via-name" to={profilePath(pubkey)}>
            <NameOf pubkey={pubkey} />
          </Link>
        </span>
      ))}
      {rest > 0
        ? ` and ${rest} ${rest === 1 ? "other" : "others"} you follow`
        : " you follow"}
    </>
  );
}

/** The profile header; see the module comment. */
export function ProfileHeader(props: ProfileHeaderProps) {
  const { pubkey, profile, viewer, hops, stats, statsFailed, followedBy } =
    props;
  const [bannerBroken, setBannerBroken] = useState(false);
  const [editing, setEditing] = useState(false);
  const isMine = viewer === pubkey;
  const name = displayNameOf(profile, pubkey);
  const nip05 = profile.nip05?.replace(/^_@/, "");
  const site = websiteUrl(profile.website);
  const npub = shortNpub(pubkey);
  const value = (n: number | undefined) =>
    statsFailed || n === undefined ? "–" : formatCount(n);

  return (
    <section class="card profile-header" aria-label={`Profile of ${name}`}>
      <div
        class="profile-header__banner"
        style={{ background: gradientFor(pubkey) }}
      >
        {profile.banner && !bannerBroken && (
          <img
            class="profile-header__banner-img"
            src={profile.banner}
            alt=""
            decoding="async"
            onError={() => setBannerBroken(true)}
          />
        )}
      </div>

      <div class="profile-header__body">
        <div class="profile-header__top">
          <span class="profile-header__avatar">
            <Avatar pubkey={pubkey} size={112} />
          </span>
          <div class="profile-header__actions">
            {isMine
              ? (
                <Button
                  variant="secondary"
                  icon={<Pencil size={16} />}
                  onClick={() => (canSign.value
                    ? setEditing(true)
                    : openLogin())}
                >
                  Edit profile
                </Button>
              )
              : (
                <FollowButton
                  pubkey={pubkey}
                  name={name}
                  onChanged={props.onChanged}
                />
              )}
          </div>
        </div>

        <div class="profile-header__identity">
          <h1 class="profile-header__name">{name}</h1>
          {nip05 && <p class="profile-header__nip05">{nip05}</p>}
          <Standing hops={hops} isMine={isMine} />
        </div>

        {profile.about && (
          <div class="profile-header__about">
            <NoteContent content={profile.about} noMedia />
          </div>
        )}

        <div class="profile-header__meta">
          {site && (
            <a
              class="profile-header__site"
              href={site.href}
              target="_blank"
              rel="noopener noreferrer nofollow"
            >
              <Globe size={15} aria-hidden="true" />
              {site.host + (site.pathname === "/" ? "" : site.pathname)}
            </a>
          )}
          <span class="profile-header__npub">
            <span class="mono">{npub}</span>
            <IconButton
              label="Copy npub"
              size="sm"
              icon={<Copy size={15} />}
              onClick={() => void copyText(toNpub(pubkey), "npub")}
            />
          </span>
        </div>

        <div class="profile-stats" role="group" aria-label="Counts">
          <button
            type="button"
            class="profile-stat"
            onClick={() => props.onTab("following")}
          >
            <span class="profile-stat__value">{value(stats?.following)}</span>
            <span class="profile-stat__label">Following</span>
          </button>
          <button
            type="button"
            class="profile-stat"
            onClick={() => props.onTab("followers")}
          >
            <span class="profile-stat__value">{value(stats?.followers)}</span>
            <span class="profile-stat__label">Followers</span>
          </button>
          <button
            type="button"
            class="profile-stat"
            onClick={() => props.onTab("notes")}
          >
            <span class="profile-stat__value">{value(stats?.notes)}</span>
            <span class="profile-stat__label">Notes</span>
          </button>
        </div>

        {!isMine && (followedBy === undefined || followedBy.length > 0) && (
          <p class="profile-header__via muted">
            {followedBy && followedBy.length > 0 && (
              <FollowedBy pubkeys={followedBy} />
            )}
          </p>
        )}
      </div>

      {isMine && (
        <EditProfileDialog
          open={editing}
          onClose={() => setEditing(false)}
          profile={profile}
        />
      )}
    </section>
  );
}
