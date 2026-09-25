# What GitHub offers a cockpit for steering and identity

Research for #20, part of the map #19 (*Cockpit: steer many factories from one place*).
Sources are docs.github.com, read 2026-09-25. Where a line is my inference rather than
something the docs say, it is marked **(inference)**.

## Answer

Build the cockpit as a **GitHub App** that each team registers for itself (the manifest flow
makes that a single click), and have it **act as the signed-in user through the App's user
access tokens**. A gate answer or a route label posted that way is authored by the person
(`user.login` is theirs), so the factory's existing `trusted_authors` check passes unchanged.
The App's single webhook covers every repository it is installed on, which is how many repos
get observed. Polling with conditional requests is the fallback when the cockpit can't be
reached from GitHub (a local cockpit, for example). Reading config, opening PRs and checking
permissions all have first-party endpoints that both token kinds can call. The cost to an org
is one install by an owner. An OAuth App would avoid that install, but it needs the `repo`
scope (full access to private code) and a separate webhook per repository, and orgs block
OAuth Apps by default anyway.

## 1. GitHub App vs OAuth App

| | GitHub App | OAuth App |
|---|---|---|
| Permissions | Fine-grained per resource: "request access only to what they need" | Coarse scopes; private repo issues need `repo` = "full access to public and private repositories including read and write access to code…" |
| Repo reach | "the app access to a user or organization account's **chosen** repositories" | "the user's accessible resources" |
| Acts as user | Yes (user access token) | Yes (its only mode) |
| Acts as itself | Yes (installation token, shows as `@app[bot]`) | No |
| Webhooks | "a single webhook that receives the events … for every repository they have access to" | Must be set up per repo/org by hand |
| Rate limits | Scale with repos/users (installation token) | Fixed 5,000/h |
| Token life | Installation token 1 h; user token 8 h, refresh token 6 months (on by default; you can opt out) | Long-lived by default |

Sources: [differences](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps),
[OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps),
[refreshing user tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens),
[installation auth](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation).

### What installing costs an org

- **GitHub App:** "Organization owners can install GitHub Apps on their organization." A repo
  admin can install one on repos they manage only if the App asks for no org permissions and
  not `administration`, and owners can switch that off. Members "can still select the
  organization… GitHub will send a notification to the organization owner" to install.
  ([install from third party](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party),
  [limiting access requests](https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/limiting-oauth-app-and-github-app-access-requests))
- **OAuth App:** "When you create a new organization, OAuth app access restrictions are
  enabled by default", so an owner has to approve it anyway. OAuth Apps "require organization
  approval by default and cannot be approved on a per-repository basis."
  ([OAuth restrictions](https://docs.github.com/en/organizations/managing-oauth-access-to-your-organizations-data/about-oauth-app-access-restrictions))
- **Self-hosted fit:** a *private* App "can only [be installed] on the account that owns the
  app" ([about creating apps](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-creating-github-apps)).
  That is exactly the single-org, self-hosted audience. The **manifest flow** lets a person
  "follow a URL and name the app", and GitHub hands back the app id, private key, client secret
  and webhook secret. The person who registers it owns it
  ([manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)).
  So the cockpit ships a manifest, not a shared public App.

## 2. Acting as the logged-in user (gate answers, labels)

- A user access token "identifies the app as the user who signed into the app". The UI shows
  "the user's avatar photo along with the app's identicon badge as the author". The audit log
  records the user as actor, with `programmatic_access_type` = "GitHub App user-to-server token"
  ([on behalf of a user](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user)).
- Access is the **intersection**: what the user can access, what the App is permitted, and
  where it is installed. "A token cannot grant additional access capabilities to a user." The
  token has no scopes: "A user access token only has permissions that both the user and the app
  have" ([generating a user token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)).
  There is a web flow for the browser cockpit and a device flow for headless use.
- The issue-comment object carries `user.login`, `author_association` and
  `performed_via_github_app` ([issue comments](https://docs.github.com/en/rest/issues/comments)).
  **(inference)** A comment posted with a user token has the *user's* login, so the factory's
  `answers_since(..., authors=trusted_authors)` accepts it with no change to the factory
  (`templates/asf/engine/issues.py`, `watch.py`). `performed_via_github_app` is also there if
  the factory ever wants to know which comments came through the cockpit.
- The factory's `trusted()` checks the **issue author**, not whoever applied the label. A route
  label applied through the cockpit is attributed to the user in the issue timeline, but the
  factory doesn't look at that today. If "who triggered this" matters, that is a separate
  factory change.
- Endpoint permissions ([permissions for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)).
  All of these accept both user access tokens and installation tokens:
  - comment `POST /repos/{o}/{r}/issues/{n}/comments`: Issues **write**
  - labels `POST /repos/{o}/{r}/issues/{n}/labels`: Issues **write**
  - list comments: Issues read

## 3. Webhooks vs polling across many repos

- **App webhook:** one per App, covering every repo in every installation. The relevant events
  are `issue_comment`, `issues` (labeled), `pull_request`, `pull_request_review`, `push` (config
  changed on the default branch), plus `installation` and `installation_repositories` (repo set
  changed) ([events](https://docs.github.com/en/webhooks/webhook-events-and-payloads)).
  "Payloads are capped at 25 MB." An org-level webhook is the non-App alternative, but "You
  must be an organization owner to create webhooks"
  ([creating webhooks](https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks)).
- **Delivery is not guaranteed:** respond with 2XX "within 10 seconds". "GitHub does not
  automatically redeliver failed deliveries". You can redeliver the past **3 days** through the
  UI or the REST API. De-duplicate on `X-GitHub-Delivery`
  ([best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks),
  [redelivering](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks)).
  **(inference)** So the cockpit needs a reconcile pass on startup (poll, or redeliver whatever
  failed) whatever else it does.
- **Reachability:** GitHub.com has to reach the receiver. For private systems, use a reverse
  proxy that allowlists the `hooks` IP ranges from the meta API and verifies the secret
  ([private systems](https://docs.github.com/en/webhooks/using-webhooks/delivering-webhooks-to-private-systems)).
  **(inference)** The local single-user cockpit usually won't be reachable, so it polls.
- **Polling:** "subscribe to webhook events instead of polling". If you do poll, keep to a fixed
  schedule, honour `x-poll-interval`, and send ETag / `if-none-match`: "a conditional request
  does not count against your primary rate limit if a 304 response is returned"
  ([REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)).

## 4. Reading `asf/factory.yaml` and `asf/workflows/**`

- `GET /repos/{o}/{r}/contents/{path}` with no `ref` reads "the repository's default branch".
  Files ≤1 MB work fully, 1–100 MB need the raw media type, and a directory lists at most 1,000
  entries ([contents](https://docs.github.com/en/rest/repos/contents)).
- For the whole `asf/workflows/` tree in one call, use `GET /repos/{o}/{r}/git/trees/{sha}?recursive=1`.
  Its limit is "100,000 entries with a maximum size of 7 MB", and it reports `truncated`
  ([trees](https://docs.github.com/en/rest/git/trees)). Then fetch the blobs. Both need
  Contents **read**.
- **(inference)** Cache by tree SHA and refresh on the `push` webhook to the default branch, so
  a factory's config costs nothing until it changes.

## 5. Opening a PR on the user's behalf

Create a branch (`POST /git/refs`), write the files (`PUT /contents/{path}`, or blobs, trees and
a commit through the Git data API), then `POST /repos/{o}/{r}/pulls`. That needs Contents
**write** and Pull requests **write**, and every step accepts a user access token
([permissions for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)).
With a user token the PR is the user's and can't reach past what the user could push anyway
(the intersection above). **(inference)** That fits "a cockpit edit becomes a pull request", and
review rules then apply to the person, not to a bot.

## 6. Checking a user's permission on a repo

- `GET /repos/{o}/{r}/collaborators/{username}/permission` returns `permission` and `role_name`.
  It needs Metadata **read**, which every App has, and accepts both token kinds
  ([collaborators](https://docs.github.com/en/rest/collaborators/collaborators)).
- For the inbox, a cheaper route: with the user's token, `GET /user/installations` and
  `GET /user/installations/{id}/repositories` return the repos the user can reach through the
  App, with the user's `permissions` on each
  ([installations](https://docs.github.com/en/rest/apps/installations)). One call answers
  "which factories can I see", and GitHub does the authorization itself.

## 7. Rate limits

From [rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api):

- User access token (GitHub App or OAuth): **5,000/h per user**, shared with all apps acting
  for that user (15,000/h for Enterprise Cloud members).
- Installation token: 5,000/h, plus 50/h for each repo over 20 and each org user over 20, up
  to **12,500/h** (15,000/h on Enterprise Cloud).
- Secondary limits: **100** concurrent requests, **900 points/min** REST (2,000 GraphQL), and
  **80 content-creating requests/min and 500/h**. Comments and labels count as content-creating.
  Send mutations one at a time and "wait at least one second between each".
- **(inference)** Reads (observation, config) can go on the installation token, since its
  budget scales with repos. Writes (answers, labels, PRs) go on the user's token, whose budget
  is per person. A team's human steering stays far below 80/min.

## 8. GitHub Enterprise Server differences

- API base is `http(s)://HOSTNAME/api/v3` ([GHES quickstart](https://docs.github.com/en/enterprise-server@latest/rest/quickstart)).
  Web and OAuth URLs are on the instance's hostname.
- "Rate limits are disabled by default for GitHub Enterprise Server". A site admin sets them,
  secondary limits included ([GHES rate limits](https://docs.github.com/en/enterprise-server@latest/rest/using-the-rest-api/rate-limits-for-the-rest-api)).
  The cockpit has to read `x-ratelimit-*` headers rather than assume numbers.
- "Most features are released on GitHub.com first, then come to GitHub Enterprise Server"
  ([about GHES](https://docs.github.com/en/enterprise-server@latest/admin/overview/about-github-enterprise-server)).
  Pin to what the oldest supported GHES release has.
- The manifest flow is documented for GHES too
  ([GHES manifest](https://docs.github.com/en/enterprise-server@latest/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)).
  **(inference)** An App is registered per instance, so a GHES team registers its own App from
  the same manifest. Configuration needs a base URL, and nothing may hard-code `github.com`.
  Webhooks from a GHES instance come from inside the network, so reachability is usually easier
  than it is on github.com.

## What a later decision depends on

1. **Identity model:** a GitHub App with user access tokens gives "comment as me" plus
   App-wide webhooks. It costs one org-owner install per org, and one App registration per
   GitHub host.
2. **`trusted_authors` needs no change** for comments posted as the user. Label triggers are
   authorized by the issue author, not by who applied the label. That gap belongs to the factory.
3. **Events:** webhooks when the cockpit is reachable, polling with ETags otherwise (local
   mode), and always a reconcile on startup, because GitHub doesn't retry failed deliveries.
4. **Budgets:** writes are limited by the secondary content limits (80/min, 500/h per token).
   Reads scale on the installation token. On GHES, limits are whatever the admin set.
