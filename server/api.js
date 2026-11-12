// JSON API for signed-in students.
//   GET /api/catalog            -> games and dorms to choose from
//   GET /api/profile            -> your own profile (or null)
//   PUT /api/profile            -> create or update your profile
//   GET /api/profiles/:username -> another student's public profile
const { GAMES, DORMS } = require("./catalog");
const profiles = require("./profiles");
const { currentAnonId } = require("./auth");

const MAX_BODY = 16 * 1024;

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  // Requiring JSON also blocks cross-site form posts (browsers can't send
  // this content type cross-site without a CORS preflight we never allow).
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
    throw new profiles.ValidationError("Expected JSON.");
  }
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw new profiles.ValidationError("Request too large.");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new profiles.ValidationError("Invalid JSON.");
  }
}

// Returns true if it handled the request.
async function handle(config, req, res, url) {
  const p = url.pathname;
  if (!p.startsWith("/api/") || p === "/api/me" || p === "/api/health") return false;

  const anonId = currentAnonId(config, req);
  if (!anonId) {
    json(res, 401, { error: "Not signed in." });
    return true;
  }

  try {
    if (req.method === "GET" && p === "/api/catalog") {
      json(res, 200, { games: GAMES, dorms: DORMS });
    } else if (req.method === "GET" && p === "/api/profile") {
      json(res, 200, { profile: profiles.getOwn(anonId) });
    } else if (req.method === "PUT" && p === "/api/profile") {
      json(res, 200, { profile: profiles.save(anonId, await readJson(req)) });
    } else if (req.method === "GET" && p.startsWith("/api/profiles/")) {
      const profile = profiles.getPublic(decodeURIComponent(p.slice("/api/profiles/".length)));
      if (profile) json(res, 200, { profile });
      else json(res, 404, { error: "No such user." });
    } else {
      json(res, 404, { error: "Not found." });
    }
  } catch (err) {
    if (err instanceof profiles.ValidationError) json(res, 400, { error: err.message });
    else throw err;
  }
  return true;
}

module.exports = { handle };
