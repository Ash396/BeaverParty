// Sign-in routes, following figure 2 of the proposal:
//   GET  /auth/login     -> redirect to Petrock (Touchstone)
//   GET  /auth/callback  -> exchange code, check affiliation, compute anon ID,
//                           refuse banned accounts, set a 7-day session cookie
//   POST /auth/logout    -> clear the session cookie
//   GET  /api/me         -> whether the browser is signed in
const crypto = require("node:crypto");
const oidc = require("./oidc");
const accounts = require("./accounts");
const profiles = require("./profiles");
const moderation = require("./moderation");
const { sign, unsign, parseCookies, cookie } = require("./session");
const { computeAnonId } = require("./keyservice");

const LOGIN_COOKIE = "bp_login";
const SESSION_COOKIE = "bp_session";
const LOGIN_TTL_SECONDS = 10 * 60;

// Anon ID = HMAC(ANON_ID_KEY, email). In production the key lives only in
// the Key Service (server/keyservice.js), so we ask it. For local
// development without one, we compute it here with ANON_ID_KEY. Both give
// the same ID for the same key, so switching doesn't change any account.
async function anonIdFor(config, email) {
  if (!config.keyServiceUrl) return computeAnonId(config.anonIdKey, email);
  const res = await fetch(`${config.keyServiceUrl.replace(/\/$/, "")}/anon-id`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.keyServiceToken}` },
    body: JSON.stringify({ email }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Key Service answered ${res.status}`);
  const { anonId } = await res.json();
  if (!/^[0-9a-f]{64}$/.test(anonId || "")) throw new Error("Key Service sent a bad ID");
  return anonId;
}

// Returns the signed-in account's anon ID, or null.
function currentAnonId(config, req) {
  if (!config.authEnabled) return null;
  const session = unsign(config.sessionSecret, parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  if (!session) return null;
  const account = accounts.find(session.anonId);
  if (!account || account.banned) return null;
  return session.anonId;
}

function redirect(res, location, cookies = []) {
  res.writeHead(302, { Location: location, "Set-Cookie": cookies, "Cache-Control": "no-store" });
  res.end();
}

function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...extraHeaders });
  res.end(JSON.stringify(body));
}

// Picks where a just-verified person goes, and creates the account and
// session cookie if they're allowed in.
async function decide(config, person) {
  if (!config.allowedAffiliations.includes(person.affiliation)) {
    return { location: "/students-only.html", cookies: [], result: "refused: not a student" };
  }
  const anonId = await anonIdFor(config, person.email);
  const existing = accounts.find(anonId);
  if (existing && existing.banned) {
    return { location: "/banned.html", cookies: [], result: "refused: banned", anonId };
  }
  accounts.findOrCreate(anonId);
  const maxAgeSeconds = Math.round(config.sessionDays * 24 * 3600);
  const session = sign(config.sessionSecret, { anonId, exp: Date.now() + maxAgeSeconds * 1000 });
  return {
    location: "/app.html",
    cookies: [cookie(SESSION_COOKIE, session, { maxAgeSeconds, secure: config.secureCookies })],
    result: "signed in",
    anonId,
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function debugPage(res, person, outcome) {
  const rows = [
    ["Email", person.email],
    ["Name", person.name || "(none sent)"],
    ["Affiliation", person.affiliation || "(none sent)"],
    ["Result", outcome.result],
    ["Anonymous ID", outcome.anonId || "(not created)"],
  ].map(([k, v]) => `<tr><th>${k}</th><td>${escapeHtml(v)}</td></tr>`).join("");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Set-Cookie": outcome.cookies,
  });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BeaverParty sign-in test</title><link rel="stylesheet" href="/style.css"></head>
<body><main><h1>Sign-in test</h1>
<p>This is what Petrock sent. It's shown because DEBUG_SHOW_IDENTITY=1 and isn't saved anywhere. Turn it off before real users sign in.</p>
<table>${rows}</table>
<p><a class="button" href="${outcome.location}">Continue</a></p></main></body></html>`);
}

// Handles /auth/* and /api/me. Returns true if it handled the request.
async function handle(config, req, res, url) {
  const isAuthRoute = url.pathname.startsWith("/auth/") || url.pathname === "/api/me";
  if (!isAuthRoute) return false;

  if (url.pathname === "/api/me") {
    const anonId = currentAnonId(config, req);
    const account = anonId && accounts.find(anonId);
    const profile = anonId && profiles.getOwn(anonId);
    json(res, 200, {
      authEnabled: config.authEnabled,
      signedIn: Boolean(anonId),
      isModerator: Boolean(account && account.isModerator),
      username: profile ? profile.username : null,
      warning: anonId ? moderation.pendingWarning(anonId) : null,
      invisible: Boolean(profile && profile.invisible),
    });
    return true;
  }

  if (!config.authEnabled) {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end(`Sign-in is not configured. Missing: ${config.missing.join(", ")}. See .env.example.`);
    return true;
  }

  const clearLogin = cookie(LOGIN_COOKIE, "", { maxAgeSeconds: 0, secure: config.secureCookies, path: "/auth" });

  if (req.method === "GET" && url.pathname === "/auth/login") {
    const state = crypto.randomBytes(16).toString("base64url");
    const nonce = crypto.randomBytes(16).toString("base64url");
    const value = sign(config.sessionSecret, { state, nonce, exp: Date.now() + LOGIN_TTL_SECONDS * 1000 });
    redirect(res, oidc.authorizationUrl(config, { state, nonce }), [
      cookie(LOGIN_COOKIE, value, { maxAgeSeconds: LOGIN_TTL_SECONDS, secure: config.secureCookies, path: "/auth" }),
    ]);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/auth/callback") {
    const pending = unsign(config.sessionSecret, parseCookies(req.headers.cookie)[LOGIN_COOKIE]);
    const code = url.searchParams.get("code");
    if (url.searchParams.get("error") || !pending || !code || url.searchParams.get("state") !== pending.state) {
      redirect(res, "/signin-failed.html", [clearLogin]);
      return true;
    }

    let person;
    try {
      person = await oidc.completeSignIn(config, code, pending.nonce);
    } catch (err) {
      console.error("sign-in failed:", err.message);
      redirect(res, "/signin-failed.html", [clearLogin]);
      return true;
    }

    // Steps 9-16 of figure 2: non-students are turned away with nothing
    // stored; for students we keep only the anon ID and drop email and name.
    let outcome;
    try {
      outcome = await decide(config, person);
    } catch (err) {
      console.error("sign-in failed:", err.message);
      redirect(res, "/signin-failed.html", [clearLogin]);
      return true;
    }
    outcome.cookies.unshift(clearLogin);
    if (config.debugShowIdentity) {
      // Test-only: show what Petrock sent. Shown once, never stored.
      debugPage(res, person, outcome);
    } else {
      redirect(res, outcome.location, outcome.cookies);
    }
    person = null;
    return true;
  }

  if (req.method === "POST" && url.pathname === "/auth/logout") {
    redirect(res, "/", [cookie(SESSION_COOKIE, "", { maxAgeSeconds: 0, secure: config.secureCookies })]);
    return true;
  }

  res.writeHead(404);
  res.end("Not found");
  return true;
}

module.exports = { handle, currentAnonId, anonIdFor };
