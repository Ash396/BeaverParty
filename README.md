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

Sign-in follows figure 2 of the proposal. The server exchanges Petrock's one-time code for tokens itself, checks the ID token's signature, and lets in only `student` affiliations. It keeps only `HMAC(ANON_ID_KEY, email)` as the account ID, drops the email and name, refuses banned accounts, and sets a 7-day session cookie. Accounts live in memory until we pick a database.

### Tests

```sh
npm test
```

The tests run the whole sign-in flow against a fake Petrock on localhost.

## Deploy on Hyades

[Hyades](https://hyades.mit.edu/inessential.html) is SIPB's free hosting. It runs the `Dockerfile` image as a microVM at `https://beaverparty.sipb.cloud`.

1. Build and push the image to a registry Hyades can pull from, such as forgejo.mit.edu or Docker Hub.
2. On Hyades, run `create beaverparty IMAGE 3000`, or `update` if the app already exists.
3. Run `edit` and add the same settings as `.env` under `"envs"`, with `BASE_URL` set to `https://beaverparty.sipb.cloud`. Then run `restart beaverparty`.

Petrock must have `https://beaverparty.sipb.cloud/auth/callback` registered as a redirect URL.

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
