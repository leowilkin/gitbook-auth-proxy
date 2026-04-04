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
