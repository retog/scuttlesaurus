/**
 * The responsive app frame: navigation rail, main column, right rail; a top
 * bar and tab bar on small screens. Also hosts the global dialogs and toasts.
 *
 * @module
 */
import type { ComponentChildren } from "preact";
import {
  Bell,
  BookOpen,
  House,
  LogIn,
  LogOut,
  Network,
  PenLine,
  Plus,
  Search,
  Settings,
  User,
} from "lucide-preact";
import { setupRequired } from "../lib/node.ts";
import { displayNameOf, useProfile } from "../lib/profiles.ts";
import { profilePath } from "../lib/nostr.ts";
import { isActive, Link, useRoute } from "../lib/router.tsx";
import { logout, session } from "../lib/session.ts";
import { openCompose, openLogin } from "../lib/ui.ts";
import { Avatar } from "./Avatar.tsx";
import { Button, IconButton } from "./Button.tsx";
import { ComposeDialog } from "./ComposeDialog.tsx";
import { HabitatCard } from "./HabitatCard.tsx";
import { GlobalLoginDialog } from "./LoginDialog.tsx";
import { Logo, LogoMark } from "./Logo.tsx";
import { setupFinished, SetupFlow } from "./SetupFlow.tsx";
import { ThemeToggle } from "./ThemeToggle.tsx";
import { ToastHost } from "./Toast.tsx";

interface NavEntry {
  to: string;
  label: string;
  icon: ComponentChildren;
}

function IdentityChip() {
  const current = session.value;
  if (!current) {
    return (
      <div class="rail-identity">
        <Button
          class="rail-identity__signin"
          variant="secondary"
          icon={<LogIn size={18} />}
          onClick={openLogin}
        >
          Sign in
        </Button>
      </div>
    );
  }
  return <SignedInChip pubkey={current.pubkey} mode={current.mode} />;
}

function SignedInChip({ pubkey, mode }: { pubkey: string; mode: string }) {
  const profile = useProfile(pubkey);
  const name = displayNameOf(profile, pubkey);
  const sub = mode === "readonly"
    ? "read-only"
    : mode === "extension"
    ? "extension"
    : "local key";
  return (
    <div class="rail-identity">
      <Link
        class="rail-identity__avatar"
        to={profilePath(pubkey)}
        aria-label={`Your profile, ${name}`}
      >
        <Avatar pubkey={pubkey} size={40} />
      </Link>
      <Link class="rail-identity__body" to={profilePath(pubkey)}>
        <span class="rail-identity__name">{name}</span>
        <span class="rail-identity__sub">{sub}</span>
      </Link>
      <span class="rail-identity__action">
        <IconButton
          label="Sign out"
          icon={<LogOut size={18} />}
          onClick={logout}
        />
      </span>
    </div>
  );
}

/** Props of {@link Shell}. */
export interface ShellProps {
  children?: ComponentChildren;
}

/** The frame around every view. */
export function Shell({ children }: ShellProps) {
  const { pathname } = useRoute();
  if (setupRequired.value || setupFinished.value) {
    // A node without an owner has one screen only: the first-run setup.
    return (
      <>
        <SetupFlow />
        <ToastHost />
      </>
    );
  }
  const me = session.value?.pubkey;
  const nav: NavEntry[] = [
    { to: "/", label: "Home", icon: <House size={22} /> },
    { to: "/reads", label: "Reads", icon: <BookOpen size={22} /> },
    { to: "/notifications", label: "Notifications", icon: <Bell size={22} /> },
    { to: "/search", label: "Search", icon: <Search size={22} /> },
    { to: "/network", label: "Network", icon: <Network size={22} /> },
    {
      to: me ? profilePath(me) : "/settings",
      label: me ? "Profile" : "Settings",
      icon: me ? <User size={22} /> : <Settings size={22} />,
    },
  ];
  if (me) {
    nav.push({
      to: "/settings",
      label: "Settings",
      icon: <Settings size={22} />,
    });
  }

  const compose = () => session.value ? openCompose() : openLogin();

  return (
    <div class="shell">
      <a class="skip-link" href="#main">Skip to content</a>
      <aside class="shell__rail" aria-label="Sidebar">
        <Link class="rail-brand" to="/" aria-label="Scuttlesaurus home">
          <Logo size={34} />
        </Link>
        <nav class="nav" aria-label="Main">
          {nav.map((entry) => (
            <Link
              key={entry.to + entry.label}
              class="nav__item"
              to={entry.to}
              aria-label={entry.label}
              aria-current={isActive(entry.to, pathname) ? "page" : undefined}
            >
              <span class="nav__icon" aria-hidden="true">{entry.icon}</span>
              <span class="nav__label">{entry.label}</span>
            </Link>
          ))}
        </nav>
        <Button
          class="btn--new"
          variant="primary"
          size="lg"
          icon={<PenLine size={20} />}
          onClick={compose}
          title="New note"
        >
          New note
        </Button>
        <div class="rail__spacer" />
        <IdentityChip />
      </aside>

      <header class="shell__topbar">
        <Link class="topbar-brand" to="/" aria-label="Scuttlesaurus home">
          <LogoMark size={28} />
          <span class="rail-brand__word">Scuttlesaurus</span>
        </Link>
        <div class="shell__topbar-actions">
          <IconButton label="Search" to="/search" icon={<Search size={20} />} />
          <IconButton
            label="Network"
            to="/network"
            icon={<Network size={20} />}
          />
          <IconButton
            label="Settings"
            to="/settings"
            icon={<Settings size={20} />}
          />
          <ThemeToggle />
        </div>
      </header>

      <main class="shell__main" id="main" tabIndex={-1}>
        {children}
      </main>

      <aside class="shell__aside" aria-label="About this node">
        <div class="aside-tools">
          <ThemeToggle />
        </div>
        <HabitatCard />
        <p class="aside-footer muted">
          Scuttlesaurus keeps what the people near you write, and nothing else.
        </p>
      </aside>

      <nav class="shell__tabbar" aria-label="Primary">
        <Link
          class="tab"
          to="/"
          aria-current={isActive("/", pathname) ? "page" : undefined}
        >
          <House size={22} aria-hidden="true" />
          Home
        </Link>
        <Link
          class="tab"
          to="/reads"
          aria-current={isActive("/reads", pathname) ? "page" : undefined}
        >
          <BookOpen size={22} aria-hidden="true" />
          Reads
        </Link>
        <button
          type="button"
          class="tab tab--new"
          onClick={compose}
          aria-label="New note"
        >
          <span class="tab__plus">
            <Plus size={22} aria-hidden="true" />
          </span>
        </button>
        <Link
          class="tab"
          to="/notifications"
          aria-current={isActive("/notifications", pathname)
            ? "page"
            : undefined}
        >
          <Bell size={22} aria-hidden="true" />
          Alerts
        </Link>
        <Link
          class="tab"
          to={me ? profilePath(me) : "/settings"}
          aria-current={me && isActive(profilePath(me), pathname)
            ? "page"
            : undefined}
        >
          <User size={22} aria-hidden="true" />
          You
        </Link>
      </nav>

      <ComposeDialog />
      <GlobalLoginDialog />
      <ToastHost />
    </div>
  );
}
