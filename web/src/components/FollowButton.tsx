/**
 * The follow button of a profile: "Follow" / "Following" (showing "Unfollow"
 * on hover and focus). Signed-out people are sent to the login dialog; the
 * change is optimistic and rolled back with a toast when the relay refuses.
 *
 * @module
 */
import { UserCheck, UserPlus } from "lucide-preact";
import { useState } from "preact/hooks";
import { explainRefusal } from "../lib/actions.ts";
import { isOwner } from "../lib/node.ts";
import { followState, setFollow } from "../lib/people.ts";
import { canSign, session } from "../lib/session.ts";
import { openLogin } from "../lib/ui.ts";
import { Button } from "./Button.tsx";
import { toast } from "./Toast.tsx";

/** Props of {@link FollowButton}. */
export interface FollowButtonProps {
  /** Hex pubkey of the person. */
  pubkey: string;
  /** How the person is named in the confirmation toast. */
  name: string;
  /** Called after a change went through. */
  onChanged?: () => void;
}

/** Follow or unfollow a person, as the signed-in viewer. */
export function FollowButton({ pubkey, name, onChanged }: FollowButtonProps) {
  const viewer = session.value?.pubkey ?? null;
  const following = followState(viewer, pubkey);
  const [busy, setBusy] = useState(false);

  const click = async () => {
    if (!canSign.value) {
      openLogin();
      return;
    }
    if (following === undefined || busy) return;
    const next = !following;
    setBusy(true);
    try {
      await setFollow(pubkey, next);
      if (next && isOwner.value) {
        toast(
          `Following ${name}. This node will now fetch their notes.`,
          "success",
        );
      }
      onChanged?.();
    } catch (error) {
      toast(explainRefusal(error), "error");
    } finally {
      setBusy(false);
    }
  };

  if (!canSign.value) {
    return (
      <Button
        class="follow-button"
        variant="primary"
        icon={<UserPlus size={18} />}
        onClick={click}
      >
        Follow
      </Button>
    );
  }
  if (following === true) {
    return (
      <Button
        class="follow-button follow-button--on"
        variant="secondary"
        icon={<UserCheck size={18} />}
        loading={busy}
        onClick={click}
        title="Unfollow"
      >
        <span class="follow-button__on">Following</span>
        <span class="follow-button__off" aria-hidden="true">Unfollow</span>
      </Button>
    );
  }
  return (
    <Button
      class="follow-button"
      variant="primary"
      icon={<UserPlus size={18} />}
      disabled={following === undefined}
      loading={busy}
      onClick={click}
    >
      Follow
    </Button>
  );
}
