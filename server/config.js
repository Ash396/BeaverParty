// Reads settings from environment variables. For local runs, values can
// also come from a .env file in the repo root (never committed).
const fs = require("node:fs");
const path = require("node:path");

function loadDotEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let value = m[2];
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    // Real environment variables win over the file.
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

function loadConfig(env = process.env) {
  if (env === process.env) loadDotEnv(path.join(__dirname, "..", ".env"));

  const issuer = (env.PETROCK_ISSUER || "https://petrock.mit.edu").replace(/\/$/, "");
  const baseUrl = (env.BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, "");

  const config = {
    port: Number(env.PORT || 3000),
    baseUrl,
    redirectUri: `${baseUrl}/auth/callback`,
    secureCookies: baseUrl.startsWith("https://"),
    issuer,
    authorizationEndpoint: env.PETROCK_AUTHORIZATION_ENDPOINT || `${issuer}/touchstone/oidc/authorization`,
    tokenEndpoint: env.PETROCK_TOKEN_ENDPOINT || `${issuer}/oidc/token`,
    userinfoEndpoint: env.PETROCK_USERINFO_ENDPOINT || `${issuer}/oidc/userinfo`,
    jwksUri: env.PETROCK_JWKS_URI || `${issuer}/oidc/jwks`,
    clientId: env.PETROCK_CLIENT_ID,
    clientSecret: env.PETROCK_CLIENT_SECRET,
    // Anon ID = HMAC(key, email). In production the key lives only in the
    // Key Service: set KEY_SERVICE_URL and KEY_SERVICE_TOKEN and leave
    // ANON_ID_KEY out of the web server. For local development, ANON_ID_KEY
    // alone works.
    anonIdKey: env.ANON_ID_KEY,
    keyServiceUrl: env.KEY_SERVICE_URL,
    keyServiceToken: env.KEY_SERVICE_TOKEN,
    // Key that signs session cookies.
    sessionSecret: env.SESSION_SECRET,
    allowedAffiliations: (env.ALLOWED_AFFILIATIONS || "student")
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    sessionDays: Number(env.SESSION_DAYS || 7),
    // SQLite database file. On Hyades this must be on a volume.
    // Lobby chat is deleted this many days after the lobby closes.
    chatRetentionDays: Number(env.CHAT_RETENTION_DAYS || 7),
    // Heat map: an hour is only saved if at least this many opted-in
    // players were in lobbies for that game (see heatmap.js).
    heatmapK: Math.max(2, Number(env.HEATMAP_K || 5)),
    dbPath: env.DB_PATH || path.join(__dirname, "..", "data", "beaverparty.db"),
    // Test-only: after login, show the email, name, and affiliation Petrock
    // sent. Never turn this on where real users sign in.
    debugShowIdentity: env.DEBUG_SHOW_IDENTITY === "1",
  };

  const keyVars = env.KEY_SERVICE_URL ? ["KEY_SERVICE_TOKEN"] : ["ANON_ID_KEY"];
  const missing = ["PETROCK_CLIENT_ID", "PETROCK_CLIENT_SECRET", ...keyVars, "SESSION_SECRET"]
    .filter((name) => !env[name]);
  config.authEnabled = missing.length === 0;
  config.missing = missing;
  return config;
}

module.exports = { loadConfig };
