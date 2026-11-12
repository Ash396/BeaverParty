// Profiles: username and games are always shown; real name, dorm, and
// ranks are opt-in. In-game names are private here and will only be shown
// to members of a lobby for that game. Saving overwrites, so no history.
const db = require("./db");
const { GAMES, DORMS, AVATAR_COLORS, AVATAR_ITEMS } = require("./catalog");

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
  const avatar = input.avatar || {};
  const color = avatar.color || "brown";
  const item = avatar.item || "none";
  if (!AVATAR_COLORS.includes(color) || !AVATAR_ITEMS.includes(item)) throw new ValidationError("Unknown avatar.");
  return { username, realName: clean(input.realName, 60), dorm, games: cleanGames, avatar: { color, item } };
}

// The avatar for each anon ID, for lobby rosters and cards.
function avatarOf(anonId) {
  const row = db.get().prepare("SELECT avatar_color, avatar_item FROM profiles WHERE anon_id = ?").get(anonId);
  return row ? { color: row.avatar_color, item: row.avatar_item } : { color: "brown", item: "none" };
}

function getOwn(anonId) {
  const row = db.get().prepare("SELECT * FROM profiles WHERE anon_id = ?").get(anonId);
  if (!row) return null;
  const games = db.get()
    .prepare("SELECT game, rank, in_game_name FROM profile_games WHERE anon_id = ? ORDER BY game")
    .all(anonId)
    .map((g) => ({ game: g.game, rank: g.rank, inGameName: g.in_game_name }));
  return {
    username: row.username, realName: row.real_name, dorm: row.dorm, games,
    avatar: { color: row.avatar_color, item: row.avatar_item },
  };
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
    avatar: own.avatar,
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
      INSERT INTO profiles (anon_id, username, real_name, dorm, avatar_color, avatar_item) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (anon_id) DO UPDATE SET
        username = excluded.username, real_name = excluded.real_name, dorm = excluded.dorm,
        avatar_color = excluded.avatar_color, avatar_item = excluded.avatar_item, updated_at = datetime('now')
    `).run(anonId, p.username, p.realName, p.dorm, p.avatar.color, p.avatar.item);
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

module.exports = { getOwn, getPublic, save, avatarOf, ValidationError };
