# BeaverParty

A campus gaming app for MIT students: find people to play with, join lobbies, and see who's online. Team project for MIT 6.1850 (Computer Systems and Society).

So far it has a tiny web server with MIT Touchstone sign-in through SIPB's [Petrock](https://petrock.mit.edu/about), with no dependencies to install.

## Run it locally

You need [Node.js](https://nodejs.org/) 22.13 or newer (it has SQLite built in).

```sh
npm start
```

Then open http://localhost:3000. A health check is at http://localhost:3000/api/health.

### Turn on sign-in

1. Copy `.env.example` to `.env`. Git ignores `.env`, so it never gets committed.
2. Paste in the client ID and secret from the Petrock email.
3. Fill `ANON_ID_KEY` and `SESSION_SECRET` with two different random strings:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
4. Restart with `npm start` and click "Log in with Touchstone".

To check what Petrock sends, add `DEBUG_SHOW_IDENTITY=1` to `.env`. After login you'll see your email, name, affiliation, and anonymous ID on a one-time page. Nothing is saved, but leave it off anywhere real users sign in.

Sign-in follows figure 2 of the proposal. The server exchanges Petrock's one-time code for tokens itself, checks the ID token's signature, and lets in only `student` affiliations. It keeps only `HMAC(ANON_ID_KEY, email)` as the account ID, drops the email and name, refuses banned accounts, and sets a 7-day session cookie. Accounts are stored in the SQLite database at `data/beaverparty.db` (gitignored). Delete that file to start fresh.

### Moderators

Moderators see the Moderation page. To make someone a moderator, run this with the same `.env` as the server:

```sh
npm run set-moderator -- someone@mit.edu
npm run set-moderator -- someone@mit.edu --remove
```

The email is only used to compute the anonymous ID and isn't stored.

### Blocking, reports, and moderation

- **Block** (from a profile or a lobby roster): the blocked student isn't told. Neither sees lobbies the other is in or can join them, they can't endorse each other, and the blocker stops seeing the other's chat messages. Unblock from My profile.
- **Report** (from a lobby roster, a recent lobby, or a profile): pick a reason, add details if you want. The report saves a copy of the reported username and the lobby chat. The reported student never learns who reported them, and neither do moderators.
- **Moderation page** (moderators only): open reports with the saved chat. Moderators see usernames and chat, never real names, dorms, or anonymous IDs. In the chat copy, everyone except the reported student is "Player 1", "Player 2", and so on. The queue flags students reported by several people, past warnings, and reporters who file many reports or many that get dismissed. Moderators don't see reports about themselves or that they filed.
- **Decisions**: Dismiss, Warn (shown to the student once, next time they open the app), or Ban (signed out at once, can't sign in again, profile hidden, all their open reports resolved). Resolving deletes the saved copy and details; only the reason, decision, moderator, and date are kept. Bans can be lifted from the same page.
- Moderators are labeled "Mod" in lobbies and "Moderator" on their profile.

### Tests

```sh
npm test
```

The tests run the whole sign-in flow against a fake Petrock on localhost.

## Deploy on Hyades

[Hyades](https://hyades.mit.edu/inessential.html) is SIPB's free hosting. It runs our Docker image as a small VM at `https://beaverparty.sipb.cloud`.

Every push to `main` runs the tests, then builds the image and publishes it to `ghcr.io/ash396/beaverparty:latest` (see `.github/workflows/ci.yml`).

First-time setup:

1. On GitHub, open the repo's **Packages** → `beaverparty` → **Package settings** and set its visibility to **Public**, so Hyades can download the image.
2. Log in to Hyades: `kinit KERB@ATHENA.MIT.EDU`, then `ssh -K KERB@hyades.mit.edu`.
3. Create the app. If a test app named `beaverparty` already exists, first run `delete beaverparty`.
   `create beaverparty ghcr.io/ash396/beaverparty:latest 3000`
4. Run `edit` and, for `beaverparty`, add `"volumes": { "beaverparty_db": "/data" }` so the database survives restarts, then add the settings under `"envs"`. Use the same values as your `.env`, but set `BASE_URL` to `https://beaverparty.sipb.cloud`. Leave out `DEBUG_SHOW_IDENTITY`.
5. `start beaverparty`. Check `status beaverparty` and `logs beaverparty`.

To ship a new version later, merge to `main`, wait for CI to go green, then run `update` on Hyades (Hyades also updates images daily).

### Key Service (keeps the anonymous-ID key out of the web server)

`server/keyservice.js` is the only part that knows `ANON_ID_KEY`. The web server sends it the email from Petrock and gets back the anonymous ID. So someone who gets the web server's settings and database still can't turn a kerb into an account. It runs from the same image, as a second Hyades app:

1. Make a token: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
2. `create beaverparty-keys ghcr.io/ash396/beaverparty:latest 4000`
3. `edit`. For `beaverparty-keys`, set envs `ROLE=keys`, `PORT=4000`, `ANON_ID_KEY` (the **same** value the web server has now, so every account keeps its ID), and `KEY_SERVICE_TOKEN` (the token).
4. For `beaverparty`, add `KEY_SERVICE_URL=https://beaverparty-keys.sipb.cloud` and `KEY_SERVICE_TOKEN` (same token), then **remove** `ANON_ID_KEY`.
5. `start beaverparty-keys`, then `restart beaverparty`. Sign in once to check.

Without `KEY_SERVICE_URL`, the web server uses `ANON_ID_KEY` itself, which is fine on your laptop. The Key Service needs the token and answers at most 60 lookups a minute, so a stolen token can't be used to look up many kerbs quickly. Give `set-moderator` the same `KEY_SERVICE_URL` and token.

Petrock must have `https://beaverparty.sipb.cloud/auth/callback` registered as a redirect URL. The database is the file `/data/beaverparty.db` on the `beaverparty_db` volume. Back it up with `expvol beaverparty_db`.

## Layout

```
public/     The web pages (HTML, CSS, JS) the browser loads
  index.html  landing page for signed-out visitors
  app.html    the app: sidebar (bottom tabs on phones) + Lobbies, My profile, Heat map, Moderation
  style.css   shared styles; the team palette and dark/light colors are variables at the top
  theme.js    dark mode by default, with a light mode toggle remembered in the browser
  avatar.js   pixel beaver avatars (fur color + accessory), drawn as SVG
server/     The Node.js server
  auth.js     sign-in routes (/auth/login, /auth/callback, /auth/logout, /api/me)
  oidc.js     talks to Petrock: code exchange, ID token check, userinfo
  session.js  signed cookies
  db.js       SQLite database and table definitions (all keyed by anonymous ID)
  accounts.js accounts: banned and moderator flags
  blocks.js   blocking
  moderation.js reports, the moderation queue, warnings, and bans
  profiles.js profiles: username, games, opt-in real name and dorm
  catalog.js  fixed game and dorm lists (games from the team survey)
  api.js      JSON API for signed-in students (profiles, lobbies, chat, live events)
  lobbies.js  lobbies (open/full/closed), members, chat, old-chat cleanup
  events.js   live updates to browsers over Server-Sent Events
  presence.js online/invisible status: online while the app is open, kept in memory only
  endorsements.js badges players give each other after a lobby closes
  keyservice.js the Key Service: holds ANON_ID_KEY, turns emails into anonymous IDs
  deletion.js deleting your account (keeps only the bare ID row while a report naming you is open)
  config.js   settings from environment variables or .env
test/       Tests (npm test)
```

## Next steps

The proposal describes six services (Auth, Profile, Lobby, Presence, Endorsement, Moderation). All but the heat map's data are built: Auth, Profile, Lobby, Presence, Endorsement, and Moderation, plus blocking. The Key Service is built too. Still to come: the heat map, and maybe friends.
