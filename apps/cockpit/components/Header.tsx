"use client";

import { Menu } from "@base-ui/react/menu";
import { Check, LogOut, Monitor, Moon, Play, Sun, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { type Theme, THEMES } from "./theme";
import { useTheme } from "./useTheme";
import { Button, cx, menuItem, menuPopup } from "./ui";

export type Me = FunctionReturnType<typeof api.viewer.me>;

/**
 * The header every page sits under (#105): the brand — with "local" under it
 * in a local cockpit — the three places, Run a prompt (#108), the one way
 * to start one, and the viewer's avatar, whose menu holds who they are,
 * which kind of cockpit this is, the theme, and Sign out in a team
 * cockpit. It stands up from the page: the card surface over the page's
 * grey, and the place you are in underlined in the accent on its rule.
 */
export function Header({ me, path, onSignOut, onRun }: { me: Me | undefined; path: string; onSignOut: () => void; onRun: () => void }) {
  const known = knows(me);
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface/95 shadow-[0_1px_3px_rgb(0_0_0/0.05)] backdrop-blur dark:border-line-strong">
      <div className="mx-auto flex h-14 max-w-[1280px] items-center gap-3 px-4 md:gap-6 md:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2 text-fg hover:no-underline" aria-label="cockpit">
          <Logo />
          {/* On a phone the mark alone: the three places need the width. */}
          <span className="hidden flex-col leading-none sm:flex">
            <span className="font-semibold tracking-tight">cockpit</span>
            {/* Only a local cockpit says so: a team's is the default, and says nothing. */}
            {me?.mode === "local" ? <span className="mt-0.5 text-[10px] font-medium tracking-wider text-muted uppercase">local</span> : null}
          </span>
        </Link>
        {known ? <Places path={path} /> : null}
        <span className="grow" />
        {known ? (
          <Button size="sm" aria-label="Run a prompt" onClick={onRun}>
            <Play size={12} fill="currentColor" aria-hidden="true" />
            {/* On a phone the icon alone, beside the three places. */}
            <span className="hidden sm:inline">Run a prompt</span>
          </Button>
        ) : null}
        {me !== undefined ? <AvatarMenu me={me} onSignOut={onSignOut} /> : null}
      </div>
    </header>
  );
}

/** Whether the cockpit knows who is looking: a local one always, a team's once they signed in. */
export function knows(me: Me | undefined): boolean {
  return me !== undefined && (me.mode === "local" || me.viewer !== null);
}

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#2f5bd3" />
      <path d="M7 25L7 15L13 7L13 15L19 7L19 15L25 7L25 25Z" fill="none" stroke="#fbfbfa" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

type Place = "now" | "sessions" | "factories";

const PLACES: { id: Place; href: string; label: string }[] = [
  // Now is today's Inbox until the Now page lands (#115).
  { id: "now", href: "/", label: "Now" },
  { id: "sessions", href: "/sessions", label: "Sessions" },
  { id: "factories", href: "/factories", label: "Factories" },
];

/** Which of the three places `path` is in; Stations, Cost and Run are in none, though their pages still work. */
export function placeOf(path: string): Place | null {
  // "/" is Now itself, not every path under it.
  const place = PLACES.find(({ href }) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`)));
  return place?.id ?? null;
}

function Places({ path }: { path: string }) {
  const here = placeOf(path);
  return (
    <nav className="flex h-full items-stretch gap-1 sm:gap-3" aria-label="Places">
      {PLACES.map((place) => (
        <Link key={place.id} href={place.href} aria-current={place.id === here ? "page" : undefined}
              className={cx(
                "relative flex items-center px-1.5 text-sm font-medium hover:no-underline sm:text-base",
                "after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full",
                place.id === here ? "text-fg after:bg-accent" : "text-muted hover:text-fg",
              )}>{place.label}</Link>
      ))}
    </nav>
  );
}

/** What the avatar menu says of the viewer: their login, which cockpit this is, and whether they can sign out. */
export function viewerMenu(me: Me): { login: string; kind: string; signOut: boolean } {
  const login = me.viewer?.login ?? "";
  if (me.mode === "local") {
    return { login, kind: me.viewer ? "Local cockpit · your own forge token" : "Local cockpit · no forge token yet", signOut: false };
  }
  const forge = me.forge.host === "github.com" || !me.forge.host ? "GitHub" : me.forge.host;
  return { login, kind: `Team cockpit · signed in with ${forge}`, signOut: me.viewer !== null };
}

const THEME_ICON: Record<Theme, LucideIcon> = { system: Monitor, light: Sun, dark: Moon };

/** The viewer's avatar, and behind it who they are, the kind of cockpit, the theme and Sign out: one control instead of four. */
function AvatarMenu({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const [theme, setTheme] = useTheme();
  const { login, kind, signOut } = viewerMenu(me);
  return (
    <Menu.Root>
      <Menu.Trigger aria-label={login ? `Signed in as ${login}` : kind}
                    className={cx(
                      "grid size-8 shrink-0 place-items-center overflow-hidden rounded-full bg-accent-soft text-sm font-semibold text-accent",
                      "ring-offset-2 ring-offset-surface hover:ring-2 hover:ring-line-strong data-popup-open:ring-2 data-popup-open:ring-accent",
                    )}>
        <Avatar url={me.viewer?.avatarUrl ?? ""} login={login} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={8} align="end" className="z-50">
          <Menu.Popup className={menuPopup}>
            <div className="px-2.5 pt-2 pb-2">
              {login ? <div className="font-medium" title={me.viewer?.name || undefined}>{login}</div> : null}
              <div className="text-xs text-muted">{kind}</div>
            </div>
            <Menu.Separator className="my-1 h-px bg-line" />
            <Menu.RadioGroup value={theme} onValueChange={(value) => setTheme(value as Theme)}>
              <Menu.GroupLabel className="px-2.5 pt-1.5 pb-1 text-xs font-medium text-muted">Theme</Menu.GroupLabel>
              {THEMES.map((each) => {
                const Icon = THEME_ICON[each];
                return (
                  <Menu.RadioItem key={each} value={each} closeOnClick={false} className={menuItem}>
                    <Icon size={14} className="text-muted" aria-hidden="true" />
                    <span className="grow capitalize">{each}</span>
                    <Menu.RadioItemIndicator><Check size={14} className="text-accent" aria-hidden="true" /></Menu.RadioItemIndicator>
                  </Menu.RadioItem>
                );
              })}
            </Menu.RadioGroup>
            {signOut ? (
              <>
                <Menu.Separator className="my-1 h-px bg-line" />
                <Menu.Item className={menuItem} onClick={onSignOut}>
                  <LogOut size={14} className="text-muted" aria-hidden="true" />Sign out
                </Menu.Item>
              </>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** The forge's picture of the viewer, or their initial when it has none or it does not load. */
function Avatar({ url, login }: { url: string; login: string }) {
  const [broken, setBroken] = useState(false);
  if (url && !broken) {
    // An avatar is the forge's image, at whatever host the forge is.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" width={32} height={32} className="size-8" onError={() => setBroken(true)} />;
  }
  return <>{login ? login[0].toUpperCase() : "?"}</>;
}
