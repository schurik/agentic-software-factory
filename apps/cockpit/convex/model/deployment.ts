/**
 * Where the backend runs, as far as its own site URL tells: what /setup says
 * to print a setup code with. A Convex Cloud deployment's site is
 * `https://<name>.convex.site` (or `<name>.<region>.convex.site`), and its
 * functions run from the dashboard; anything else is the compose file's
 * backend, run with `docker compose exec`.
 */
const CLOUD_SITE = /^https:\/\/([a-z0-9-]+)(?:\.[a-z0-9-]+)?\.convex\.site\/?$/;

/** The Convex dashboard's functions page for the deployment at `siteUrl`, or null when it is not on Convex Cloud. */
export function dashboardOf(siteUrl: string): string | null {
  const name = CLOUD_SITE.exec(siteUrl.trim())?.[1];
  return name ? `https://dashboard.convex.dev/d/${name}/functions` : null;
}
