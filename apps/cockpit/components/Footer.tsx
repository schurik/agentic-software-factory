"use client";

import { Popover } from "@base-ui/react/popover";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Deploy } from "@/convex/deploys";
import { type Build, buildLabel, commitHref, isCiBuild, sameBuild, shortCommit } from "@/convex/model/build";
import { useClock } from "./clock";
import { formatAgoAt, formatTime } from "./format";
import { cx, menuPopup } from "./ui";

/**
 * Which build of the cockpit is serving this page, bottom right under every
 * page: its ref, commit and run, and when it was deployed here. Opened, it
 * says the same in full and lists the deploys before it — each new image
 * `docker/start.sh` started on this deployment (deploys.ts).
 */
export function Footer({ build, signIn }: { build: Build; signIn?: string }) {
  const deploys = useQuery(api.deploys.recent, { signIn }) ?? [];
  const now = useClock();
  return (
    <footer className="mx-auto flex max-w-[1280px] justify-end px-4 pb-6 md:px-6">
      <Popover.Root>
        <Popover.Trigger className="rounded-md px-1.5 py-0.5 font-mono text-xs text-faint hover:text-fg data-popup-open:text-fg">
          {footerLine(build, deployedAt(build, deploys), now)}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="top" align="end" sideOffset={6} collisionPadding={12} className="z-[60]">
            <Popover.Popup className={cx(menuPopup, "w-[min(24rem,calc(100vw-2rem))] p-3 text-sm")}>
              <BuildDetails build={build} deploys={deploys} now={now} />
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </footer>
  );
}

/** When the build being served was first started here, if this deployment recorded it. */
export function deployedAt(build: Build, deploys: Deploy[]): number | null {
  return deploys.find((deploy) => sameBuild(deploy.build, build))?.at ?? null;
}

/** "main · a1b2c3d · #42 · deployed 3h ago". */
export function footerLine(build: Build, at: number | null, now: number): string {
  const label = buildLabel(build);
  return at === null ? label : `${label} · deployed ${formatAgoAt(at, now)}`;
}

/** The build in full, and the deploys this deployment recorded, newest first. */
export function BuildDetails({ build, deploys, now }: { build: Build; deploys: Deploy[]; now: number }) {
  const at = deployedAt(build, deploys);
  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="mb-1.5 font-semibold text-fg">This cockpit</div>
        {isCiBuild(build) ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-muted [&_dd]:text-fg">
            {build.ref ? <><dt>Built from</dt><dd className="font-mono">{build.ref}</dd></> : null}
            {build.version ? <><dt>Release</dt><dd>{releaseLine(build)}</dd></> : null}
            <dt>Commit</dt>
            <dd className="font-mono"><Linked href={commitHref(build)}>{shortCommit(build)}</Linked></dd>
            {build.number ? <><dt>Build</dt><dd><Linked href={build.runUrl}>#{build.number}</Linked></dd></> : null}
            {build.builtAt ? <><dt>Built</dt><dd>{formatTime(build.builtAt, now)}</dd></> : null}
            <dt>Deployed</dt>
            <dd>{at === null ? "not recorded here" : `${formatTime(new Date(at).toISOString(), now)} (${formatAgoAt(at, now)})`}</dd>
          </dl>
        ) : (
          <p className="text-muted">A local build: nothing says which commit it is, and its deploys are not recorded.</p>
        )}
      </div>
      {deploys.length > 0 ? (
        <div>
          <div className="mb-1.5 font-semibold text-fg">Deploys</div>
          <ol className="flex flex-col gap-1">
            {deploys.map((deploy) => (
              <li key={deploy.at} className="flex items-baseline justify-between gap-3">
                <span className={cx("font-mono text-xs", sameBuild(deploy.build, build) ? "text-fg" : "text-muted")}>
                  <Linked href={commitHref(deploy.build)}>{buildLabel(deploy.build)}</Linked>
                  {sameBuild(deploy.build, build) ? <span className="ml-1.5 font-sans text-accent">serving</span> : null}
                </span>
                <span className="shrink-0 text-xs text-faint" title={new Date(deploy.at).toISOString()}>
                  {formatAgoAt(deploy.at, now)}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

/** "1.3.0" for a release's own build; on main, the release it follows. */
function releaseLine(build: Build): string {
  return build.ref === `v${build.version}` ? build.version : `after ${build.version}`;
}

function Linked({ href, children }: { href: string; children: React.ReactNode }) {
  if (!href) return <>{children}</>;
  return <a href={href} target="_blank" rel="noreferrer" className="hover:text-accent hover:underline">{children}</a>;
}
