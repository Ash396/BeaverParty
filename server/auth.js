// Sign-in routes, following figure 2 of the proposal:
//   GET  /auth/login     -> redirect to Petrock (Touchstone)
//   GET  /auth/callback  -> exchange code, check affiliation, compute anon ID,
//                           refuse banned accounts, set a 7-day session cookie
//   POST /auth/logout    -> clear the session cookie
//   GET  /api/me         -> whether the browser is signed in
const crypto = require("node:crypto");
const oidc = require("./oidc");
const accounts = require("./accounts");
const { sign, unsign, parseCookies, cookie } = require("./session");

const LOGIN_COOKIE = "bp_login";
const SESSION_COOKIE = "bp_session";
const LOGIN_TTL_SECONDS = 10 * 60;

function anonIdFor(config, email) {
  return crypto.createHmac("sha256", config.anonIdKey).update(email).digest("hex");
}

// Returns the signed-in account's anon ID, or null.
function currentAnonId(config, req) {
  if (!config.authEnabled) return null;
  const session = unsign(config.sessionSecret, parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  if (!session) return null;
  const account = accounts.find(session.anonId);
  if (account && account.banned) return null;
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

// Handles /auth/* and /api/me. Returns true if it handled the request.
async function handle(config, req, res, url) {
  const isAuthRoute = url.pathname.startsWith("/auth/") || url.pathname === "/api/me";
  if (!isAuthRoute) return false;

  if (url.pathname === "/api/me") {
    const anonId = currentAnonId(config, req);
    json(res, 200, { authEnabled: config.authEnabled, signedIn: Boolean(anonId) });
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

    // Steps 9-12 of figure 2: non-students are turned away with nothing
    // stored; for students we keep only the anon ID and drop email and name.
    if (!config.allowedAffiliations.includes(person.affiliation)) {
      redirect(res, "/students-only.html", [clearLogin]);
      return true;
    }
    const anonId = anonIdFor(config, person.email);
    person = null;

    const existing = accounts.find(anonId);
    if (existing && existing.banned) {
      redirect(res, "/banned.html", [clearLogin]);
      return true;
    }
    accounts.findOrCreate(anonId);

    const maxAgeSeconds = Math.round(config.sessionDays * 24 * 3600);
    const session = sign(config.sessionSecret, { anonId, exp: Date.now() + maxAgeSeconds * 1000 });
    redirect(res, "/", [
      clearLogin,
      cookie(SESSION_COOKIE, session, { maxAgeSeconds, secure: config.secureCookies }),
    ]);
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
