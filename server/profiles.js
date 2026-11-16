// Profiles: username and games are always shown; real name, dorm, majors, and
// ranks are opt-in. In-game names are private here and will only be shown
// to members of a lobby for that game. Saving overwrites, so no history.
const db = require("./db");
const { GAMES, DORMS, MAJORS, MAX_MAJORS, AVATAR_COLORS, AVATAR_ITEMS } = require("./catalog");
const presence = require("./presence");

const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;

class ValidationError extends Error {}

// Thrown by save() when the opt-in fields being saved could point to one
// student. The API turns it into a warning the student can accept.
class RiskWarning extends Error {
  constructor(warning) {
    super("Fewer than a few other students share what you're about to show.");
    this.warning = warning;
  }
}

function clean(value, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ValidationError("expected text");
  const v = value.trim();
  if (v.length > max) throw new ValidationError(`must be at most ${max} characters`);
  return v || null;
}

function validateMajors(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.some((m) => typeof m !== "string" || !MAJORS.has(m))) {
    throw new ValidationError("Unknown major.");
  }
  if (input.length > MAX_MAJORS) throw new ValidationError(`Pick at most ${MAX_MAJORS} majors.`);
  // Two picks in one department ("6" and "6-3", or "6-3" and "6-4") would
  // be one major listed twice, unless both are real joint programs; keep it simple.
  const depts = input.map((m) => MAJORS.get(m)).filter((d) => d !== null);
  if (new Set(input).size !== input.length || new Set(depts).size !== depts.length) {
    throw new ValidationError("Pick each department only once.");
  }
  if (input.includes("Undeclared") && input.length > 1) throw new ValidationError("Undeclared can't be combined with a major.");
  return input;
}

function validate(input) {
  if (!input || typeof input !== "object") throw new ValidationError("expected a profile");
  const username = clean(input.username, 20);
  if (!username || !USERNAME_RE.test(username)) {
    throw new ValidationError("Username must be 3-20 letters, numbers, _ or -.");
  }
  const dorm = clean(input.dorm, 40);
  if (dorm && !DORMS.includes(dorm)) throw new ValidationError("Unknown dorm.");
  const majors = validateMajors(input.majors);
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
  return { username, realName: clean(input.realName, 60), dorm, majors, games: cleanGames, avatar: { color, item } };
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
    majors: db.get().prepare("SELECT major FROM profile_majors WHERE anon_id = ? ORDER BY position").all(anonId).map((m) => m.major),
    avatar: { color: row.avatar_color, item: row.avatar_item },
    invisible: Boolean(row.invisible),
  };
}

// What other students see: no in-game names, no anon ID, and not whether
// you're invisible (an invisible student just shows as offline). Moderators
// are labeled. Banned students' profiles are hidden.
function getPublic(username) {
  const row = db.get().prepare(`
    SELECT p.anon_id, a.is_moderator, a.banned FROM profiles p JOIN accounts a ON a.anon_id = p.anon_id
    WHERE p.username = ?
  `).get(username);
  if (!row || row.banned) return null;
  const own = getOwn(row.anon_id);
  return {
    username: own.username,
    online: presence.isOnline(row.anon_id),
    realName: own.realName,
    dorm: own.dorm,
    majors: own.majors,
    avatar: own.avatar,
    games: own.games.map(({ game, rank }) => ({ game, rank })),
    isModerator: Boolean(row.is_moderator),
  };
}

// ---- Re-identification warning ----
// Opt-in fields are harmless one at a time but can point to one student
// together (Simmons + 6-3 + Immortal in Valorant). Before saving, we count
// the other BeaverParty students who show the same dorm, the same majors,
// and the same rank in each game you give a rank for. If fewer than k do,
// the student is warned and has to confirm. Real name is always warned
// about when it's added or changed. The count itself is never shown (only
// "fewer than k"), so the warning can't be used to probe who has what.

// What a profile exposes beyond username and games, as a comparable key.
function exposure(p) {
  const ranks = p.games.filter((g) => g.rank).map((g) => `${g.game}=${g.rank.toLowerCase()}`).sort();
  return { dorm: p.dorm || null, majors: [...(p.majors || [])].sort(), ranks };
}

// Does `next` show anything `prev` didn't? Removing fields never warns.
function addsExposure(prev, next) {
  if (!prev) return true;
  if (next.dorm && next.dorm !== prev.dorm) return true;
  if (next.majors.some((m) => !prev.majors.includes(m))) return true;
  return next.ranks.some((r) => !prev.ranks.includes(r));
}

function othersSharing(anonId, mine) {
  const conn = db.get();
  const majorsOf = conn.prepare("SELECT major FROM profile_majors WHERE anon_id = ?");
  const ranksOf = conn.prepare("SELECT game, rank FROM profile_games WHERE anon_id = ? AND rank IS NOT NULL");
  let n = 0;
  for (const row of conn.prepare(`
    SELECT p.anon_id, p.dorm FROM profiles p JOIN accounts a ON a.anon_id = p.anon_id
    WHERE p.anon_id <> ? AND a.banned = 0
  `).all(anonId)) {
    if (mine.dorm && row.dorm !== mine.dorm) continue;
    if (mine.majors.length) {
      const theirs = majorsOf.all(row.anon_id).map((m) => m.major).sort();
      if (JSON.stringify(theirs) !== JSON.stringify(mine.majors)) continue;
    }
    if (mine.ranks.length) {
      const theirs = new Set(ranksOf.all(row.anon_id).map((g) => `${g.game}=${g.rank.toLowerCase()}`));
      if (!mine.ranks.every((r) => theirs.has(r))) continue;
    }
    n++;
  }
  return n;
}

// Returns null, or { k, realName, fields } describing what to warn about.
function riskOf(anonId, p, k) {
  const before = getOwn(anonId);
  const realName = Boolean(p.realName) && (!before || before.realName !== p.realName);
  const mine = exposure(p);
  const fields = [];
  if (mine.dorm) fields.push("dorm");
  if (mine.majors.length) fields.push(mine.majors.length > 1 ? "majors" : "major");
  if (mine.ranks.length) fields.push(mine.ranks.length > 1 ? "ranks" : "rank");
  const changed = addsExposure(before && exposure(before), mine);
  const rare = fields.length > 0 && changed && othersSharing(anonId, mine) < k;
  if (!realName && !rare) return null;
  return { k, realName, fields: rare ? fields : [] };
}

// Returns the saved profile, or throws ValidationError. With options.k
// set (the API does), also throws RiskWarning unless options.acknowledged.
function save(anonId, input, options = {}) {
  const p = validate(input);
  const conn = db.get();
  const taken = conn.prepare("SELECT anon_id FROM profiles WHERE username = ?").get(p.username);
  if (taken && taken.anon_id !== anonId) throw new ValidationError("That username is taken.");
  if (options.k && !options.acknowledged) {
    const warning = riskOf(anonId, p, options.k);
    if (warning) throw new RiskWarning(warning);
  }
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
    conn.prepare("DELETE FROM profile_majors WHERE anon_id = ?").run(anonId);
    const addMajor = conn.prepare("INSERT INTO profile_majors (anon_id, position, major) VALUES (?, ?, ?)");
    p.majors.forEach((m, i) => addMajor.run(anonId, i, m));
    conn.exec("COMMIT");
  } catch (err) {
    conn.exec("ROLLBACK");
    throw err;
  }
  return getOwn(anonId);
}

function anonIdOf(username) {
  const row = db.get().prepare("SELECT anon_id FROM profiles WHERE username = ?").get(username);
  return row ? row.anon_id : null;
}

module.exports = { anonIdOf, getOwn, getPublic, save, avatarOf, ValidationError, RiskWarning };
