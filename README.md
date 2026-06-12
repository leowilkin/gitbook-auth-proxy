# gitbook-auth-proxy

authenticated access proxy for gitbook using hack club auth + slack-managed whitelist.

## how it works

1. user visits your gitbook site → gitbook redirects to `/login?location=...`
2. service redirects to hack club auth oauth (requesting `openid slack_id`)
3. user logs in → callback with auth code → exchange for tokens → get slack ID
4. if slack ID is whitelisted → sign gitbook JWT → redirect back to gitbook
5. if not → show "access denied" page

admins manage the whitelist via a slack slash command (`/docs`).

## setup

### 1. hack club auth

- go to https://auth.hackclub.com and create a developer app
- set redirect URI to `https://yourapp.com/callback`
- note client ID and secret

### 2. gitbook

- enable authenticated access on your gitbook site
- set the fallback URL to `https://yourapp.com/login`
- copy the signing key

### 3. slack app

- create a slack app at https://api.slack.com/apps
- add a slash command:
  - command: `/docs`
  - request URL: `https://yourapp.com/slack/command`
- copy the signing secret from "basic information"

### 4. deploy

```bash
cp .env.example .env
# fill in .env

# docker compose
docker compose up -d

# or locally
npm install
npm run dev
```

set `SEED_ADMIN_SLACK_ID` to your slack user ID for initial bootstrap — this creates the first admin on first boot.

## slash commands

all commands require admin access:

| command | description |
|---|---|
| `/docs whitelist add @user` | grant access to the gitbook site |
| `/docs whitelist remove @user` | revoke access |
| `/docs whitelist list` | show all whitelisted users |
| `/docs admin add @user` | grant admin privileges |
| `/docs admin remove @user` | revoke admin privileges |
| `/docs admin list` | show all admins |
| `/docs group add <name> @user` | add a user to an adaptive-content group |
| `/docs group add <name> channel` | add everyone in this channel to a group |
| `/docs group remove <name> @user` | remove a user from a group |
| `/docs group remove <name> channel` | remove everyone in this channel from a group |
| `/docs group list` | show all groups and member counts |
| `/docs group list <name>` | show members of a group |

## app home (interactive UI)

admins can manage everything from the bot's **Home tab** in slack instead of typing
slash commands — it shows the whitelist count, admins, and groups, with buttons that
open pickers to manage them. you can create, rename (with a description), and delete
groups, and add/remove members via dropdown — all without leaving slack. non-admins
see a read-only summary.

to enable it in your slack app config (https://api.slack.com/apps):

1. **App Home** → turn on the **Home Tab**.
2. **Interactivity & Shortcuts** → turn on interactivity, set request URL to
   `https://yourapp.com/slack/interactivity`.
3. **Event Subscriptions** → enable events, set request URL to
   `https://yourapp.com/slack/events` (slack will verify it with a challenge — the
   service answers automatically), then subscribe to the bot event `app_home_opened`.
4. **OAuth & Permissions** → ensure the bot has `conversations.members` access
   (`channels:read` / `groups:read`) for channel sync; reinstall the app if you
   changed scopes.

then open the bot from your slack sidebar → **Home** tab.

## adaptive content (per-section access)

the whitelist gates the whole site. to gate individual sections/pages to a subset
of users (e.g. only full-time HQ staff see the employee handbook), use gitbook's
[adaptive content](https://gitbook.com/docs/site-access/adaptive-content) on top.

how it works: each **group** a user belongs to is signed into their gitbook JWT as
a boolean claim. group `fulltime` → `visitor.claims.fulltime == true`.

setup:

1. create a group and add members, e.g. `/docs group add fulltime channel` while in
   your `#hq-fulltime` channel (members must also be whitelisted to access the site
   at all).
2. in gitbook → **Settings → Audience**, enable adaptive content and define a boolean
   claim per group name you use (e.g. `fulltime`, `finance`).
3. on the section/page, set visibility to a condition like
   `visitor.claims.fulltime == true`.

group membership is a snapshot — re-run `/docs group add <name> channel` to re-sync
after people join or leave the channel. claims refresh on each login (JWTs last 2h).

## env vars

| var | description |
|---|---|
| `HC_CLIENT_ID` | hack club auth oauth client ID |
| `HC_CLIENT_SECRET` | hack club auth oauth client secret |
| `HC_REDIRECT_URI` | oauth callback URL (e.g. `https://yourapp.com/callback`) |
| `GITBOOK_SIGNING_KEY` | from gitbook authenticated access settings |
| `GITBOOK_DOCS_URL` | your gitbook site URL |
| `SLACK_SIGNING_SECRET` | from slack app basic information |
| `BASE_URL` | public URL of this service |
| `PORT` | server port (default: 3000) |
| `SEED_ADMIN_SLACK_ID` | initial admin slack ID (first boot only) |
