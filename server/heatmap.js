// Heat map: when students are in lobbies, by game, day of week, and hour.
//
// Only students who opt in are counted (profiles.heatmap_opt_in), and never
// while they're invisible. Who is counted this hour is kept in memory only;
// when the hour ends we save just the number of players per game, and only
// if it's at least K. Smaller counts are thrown away, so on a small campus
// one late-night player in a niche game can't be picked out. Saved hours
// older than WEEKS weeks are deleted.
//
// The page shows, for each day of the week and hour (in campus time), the
// average number of players over the last few weeks. The current hour is
// never shown, so the map can't be used to watch someone live.
const db = require("./db");
const { GAMES } = require("./catalog");

const HOUR = 3600_000;
const ALL = "*"; // every game together, including lobbies for games not in the catalog
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Tests and HEATMAP_K change these.
const options = { k: 5, weeks: 4, timeZone: "America/New_York" };

let current = { hour: null, players: new Map() }; // game -> Set of anon IDs

function hourOf(ms) {
  return Math.floor(ms / HOUR);
}

function startedHour() {
  const row = db.get().prepare("SELECT value FROM heatmap_meta WHERE key = 'started_hour'").get();
  return row ? row.value : null;
}

function add(game, anonId) {
  if (!current.players.has(game)) current.players.set(game, new Set());
  current.players.get(game).add(anonId);
}

// Saves the finished hour's counts (only those >= k) and forgets who was in them.
function flush() {
  if (current.hour === null) return;
  const save = db.get().prepare(`
    INSERT INTO heatmap_hours (game, hour, players) VALUES (?, ?, ?)
    ON CONFLICT (game, hour) DO UPDATE SET players = max(players, excluded.players)
  `);
  for (const [game, set] of current.players) {
    if (set.size >= options.k) save.run(game, current.hour, set.size);
  }
  current.players = new Map();
  db.get().prepare("DELETE FROM heatmap_hours WHERE hour < ?").run(current.hour - options.weeks * 168);
}

// Called every minute: counts opted-in students who are in an open or full lobby.
function sample(now = Date.now()) {
  const hour = hourOf(now);
  if (current.hour !== null && hour !== current.hour) flush();
  current.hour = hour;
  db.get().prepare("INSERT OR IGNORE INTO heatmap_meta (key, value) VALUES ('started_hour', ?)").run(hour);
  const rows = db.get().prepare(`
    SELECT DISTINCT m.anon_id, l.game FROM lobby_members m
    JOIN lobbies l ON l.id = m.lobby_id
    JOIN profiles p ON p.anon_id = m.anon_id
    JOIN accounts a ON a.anon_id = m.anon_id
    WHERE l.state IN ('open', 'full') AND p.heatmap_opt_in = 1 AND p.invisible = 0 AND a.banned = 0
  `).all();
  for (const { anon_id: id, game } of rows) {
    if (GAMES.includes(game)) add(game, id);
    add(ALL, id);
  }
}

// Drop someone from the hour in progress (after opting out, going invisible,
// or deleting their account). Hours already saved hold only totals.
function forget(anonId) {
  for (const set of current.players.values()) set.delete(anonId);
}

function isOptedIn(anonId) {
  const row = db.get().prepare("SELECT heatmap_opt_in FROM profiles WHERE anon_id = ?").get(anonId);
  return Boolean(row && row.heatmap_opt_in);
}

function setOptIn(anonId, optIn) {
  const { changes } = db.get().prepare("UPDATE profiles SET heatmap_opt_in = ? WHERE anon_id = ?").run(optIn ? 1 : 0, anonId);
  if (!changes) return false;
  if (!optIn) forget(anonId);
  return true;
}

// Day of week (0 = Monday) and hour (0-23) of an hour, in campus time.
const formatters = new Map();
function campusSlot(hour) {
  if (!formatters.has(options.timeZone)) {
    formatters.set(options.timeZone, new Intl.DateTimeFormat("en-US", {
      timeZone: options.timeZone, weekday: "short", hour: "numeric", hourCycle: "h23",
    }));
  }
  const parts = formatters.get(options.timeZone).formatToParts(new Date(hour * HOUR));
  const day = DAYS.indexOf(parts.find((p) => p.type === "weekday").value);
  const h = Number(parts.find((p) => p.type === "hour").value) % 24;
  return { day, hour: h };
}

// The grid for one game: cells[day][hour] is the average number of players
// over the weeks covered, or null if that hour never reached k.
function grid(game = ALL, now = Date.now()) {
  if (game !== ALL && !GAMES.includes(game)) game = ALL;
  const nowHour = hourOf(now);
  const from = nowHour - options.weeks * 168;
  const started = startedHour();
  const weeks = started === null ? 0
    : Math.min(options.weeks, Math.max(1, Math.ceil((nowHour - Math.max(started, from)) / 168)));

  const sums = Array.from({ length: 7 }, () => Array(24).fill(0));
  const seen = Array.from({ length: 7 }, () => Array(24).fill(false));
  const rows = db.get()
    .prepare("SELECT hour, players FROM heatmap_hours WHERE game = ? AND hour >= ? AND hour < ?")
    .all(game, from, nowHour);
  for (const { hour, players } of rows) {
    const slot = campusSlot(hour);
    sums[slot.day][slot.hour] += players;
    seen[slot.day][slot.hour] = true;
  }
  const cells = sums.map((row, d) => row.map((sum, h) => (seen[d][h] ? Math.round((sum / weeks) * 10) / 10 : null)));
  return { game, games: [ALL, ...GAMES], days: DAYS, cells, k: options.k, weeks, timeZone: options.timeZone };
}

function reset() {
  current = { hour: null, players: new Map() };
}

// For tests: who is counted in the hour in progress.
function currentCount(game = ALL) {
  return (current.players.get(game) || new Set()).size;
}

module.exports = { sample, flush, forget, grid, isOptedIn, setOptIn, reset, currentCount, options, ALL };
