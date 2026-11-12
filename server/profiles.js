// Profiles: username and games are always shown; real name, dorm, and
// ranks are opt-in. In-game names are private here and will only be shown
// to members of a lobby for that game. Saving overwrites, so no history.
const db = require("./db");
const { GAMES, DORMS } = require("./catalog");

const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;

class ValidationError extends Error {}

function clean(value, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ValidationError("expected text");
  const v = value.trim();
  if (v.length > max) throw new ValidationError(`must be at most ${max} characters`);
  return v || null;
}

function validate(input) {
  if (!input || typeof input !== "object") throw new ValidationError("expected a profile");
  const username = clean(input.username, 20);
  if (!username || !USERNAME_RE.test(username)) {
    throw new ValidationError("Username must be 3-20 letters, numbers, _ or -.");
  }
  const dorm = clean(input.dorm, 40);
  if (dorm && !DORMS.includes(dorm)) throw new ValidationError("Unknown dorm.");
  const games = Array.isArray(input.games) ? input.games : [];
  if (games.length === 0) throw new ValidationError("Pick at least one game.");
  const seen = new Set();
  const cleanGames = games.map((g) => {
    if (!g || !GAMES.includes(g.game)) throw new ValidationError("Unknown game.");
    if (seen.has(g.game)) throw new ValidationError("Each game can only be listed once.");
    seen.add(g.game);
    return { game: g.game, rank: clean(g.rank, 30), inGameName: clean(g.inGameName, 40) };
  });
  return { username, realName: clean(input.realName, 60), dorm, games: cleanGames };
}

function getOwn(anonId) {
  const row = db.get().prepare("SELECT * FROM profiles WHERE anon_id = ?").get(anonId);
  if (!row) return null;
  const games = db.get()
    .prepare("SELECT game, rank, in_game_name FROM profile_games WHERE anon_id = ? ORDER BY game")
    .all(anonId)
    .map((g) => ({ game: g.game, rank: g.rank, inGameName: g.in_game_name }));
  return { username: row.username, realName: row.real_name, dorm: row.dorm, games };
}

// What other students see: no in-game names, and no anon ID.
function getPublic(username) {
  const row = db.get().prepare("SELECT anon_id FROM profiles WHERE username = ?").get(username);
  if (!row) return null;
  const own = getOwn(row.anon_id);
  return {
    username: own.username,
    realName: own.realName,
    dorm: own.dorm,
    games: own.games.map(({ game, rank }) => ({ game, rank })),
  };
}

// Returns the saved profile, or throws ValidationError.
function save(anonId, input) {
  const p = validate(input);
  const conn = db.get();
  const taken = conn.prepare("SELECT anon_id FROM profiles WHERE username = ?").get(p.username);
  if (taken && taken.anon_id !== anonId) throw new ValidationError("That username is taken.");
  conn.exec("BEGIN");
  try {
    conn.prepare(`
      INSERT INTO profiles (anon_id, username, real_name, dorm) VALUES (?, ?, ?, ?)
      ON CONFLICT (anon_id) DO UPDATE SET
        username = excluded.username, real_name = excluded.real_name,
        dorm = excluded.dorm, updated_at = datetime('now')
    `).run(anonId, p.username, p.realName, p.dorm);
    conn.prepare("DELETE FROM profile_games WHERE anon_id = ?").run(anonId);
    const addGame = conn.prepare(
      "INSERT INTO profile_games (anon_id, game, rank, in_game_name) VALUES (?, ?, ?, ?)"
    );
    for (const g of p.games) addGame.run(anonId, g.game, g.rank, g.inGameName);
    conn.exec("COMMIT");
  } catch (err) {
    conn.exec("ROLLBACK");
    throw err;
  }
  return getOwn(anonId);
}

module.exports = { getOwn, getPublic, save, ValidationError };
