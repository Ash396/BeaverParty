# BeaverParty

A campus gaming app for MIT students: find people to play with, join lobbies, and see who's online. Team project for MIT 6.1850 (Computer Systems and Society).

So far it has a tiny web server with MIT Touchstone sign-in through SIPB's [Petrock](https://petrock.mit.edu/about), with no dependencies to install.

## Run it locally

You need [Node.js](https://nodejs.org/) 18 or newer.

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

Sign-in follows figure 2 of the proposal. The server exchanges Petrock's one-time code for tokens itself, checks the ID token's signature, and lets in only `student` affiliations. It keeps only `HMAC(ANON_ID_KEY, email)` as the account ID, drops the email and name, refuses banned accounts, and sets a 7-day session cookie. Accounts live in memory until we pick a database.

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
4. Run `edit` and add the settings under `"envs"` for `beaverparty`. Use the same values as your `.env`, but set `BASE_URL` to `https://beaverparty.sipb.cloud`. Leave out `DEBUG_SHOW_IDENTITY`.
5. `start beaverparty`. Check `status beaverparty` and `logs beaverparty`.

To ship a new version later, merge to `main`, wait for CI to go green, then run `update` on Hyades (Hyades also updates images daily).

Petrock must have `https://beaverparty.sipb.cloud/auth/callback` registered as a redirect URL. Accounts are kept in memory for now, so a restart forgets them (and any bans) until we add a database.

## Layout

```
public/     The web pages (HTML, CSS, JS) the browser loads
server/     The Node.js server
  auth.js     sign-in routes (/auth/login, /auth/callback, /auth/logout, /api/me)
  oidc.js     talks to Petrock: code exchange, ID token check, userinfo
  session.js  signed cookies
  accounts.js accounts by anonymous ID (in memory for now)
  config.js   settings from environment variables or .env
test/       Tests (npm test)
```

## Next steps

The proposal describes six services (Auth, Profile, Lobby, Presence, Endorsement, Moderation). Auth is started here. We'll pick a framework and database before building the rest.
