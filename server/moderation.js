// Reports and moderation, following the team's decisions (2026-11-12):
//   - Moderators are our team, labeled as moderators on their profiles.
//   - Moderators see the reported username and a saved copy of the lobby
//     chat. Never real names, dorms, or anyone's anonymous ID.
//   - The reporter is hidden from the reported student and from moderators.
//     We store the reporter's anonymous ID only so the queue can flag
//     someone who files many reports, or many that get dismissed.
//   - A report saves its own copy of the username and chat when it's filed,
//     so renaming or chat expiry can't erase the evidence. The copy is
//     deleted when the report is resolved; only the reason, outcome, and
//     who resolved it are kept, so repeat problems can be counted.
// In the saved chat, the reported student is shown by username and everyone
// else as "Player 1", "Player 2", ..., so the copy doesn't point at the
// reporter or expose bystanders.
const db = require("./db");
const accounts = require("./accounts");
const lobbies = require("./lobbies");
const { ValidationError } = require("./profiles");
const { NotFoundError, ForbiddenError } = lobbies;

const REASONS = [
  "Harassment or hate",
  "Threats or sharing personal info",
  "Cheating or griefing",
  "Spam or scams",
  "Offensive username or profile",
  "Other",
];
const ACTIONS = { dismiss: "dismissed", warn: "warned", ban: "banned" };
const MAX_DETAILS = 500;
const MAX_REPORTS_PER_DAY = 10;
const SNAPSHOT_MESSAGES = 200;

function profileOf(username) {
  if (typeof username !== "string") return null;
  return db.get().prepare(`
    SELECT p.anon_id, p.username FROM profiles p JOIN accounts a ON a.anon_id = p.anon_id
    WHERE p.username = ? AND a.banned = 0
  `).get(username.trim()) || null;
}

// Were they in this lobby? Members who left an open lobby are no longer on
// its roster, so having chatted there counts too.
function wasIn(anonId, lobbyId) {
  return lobbies.isMember(anonId, lobbyId) || Boolean(db.get()
    .prepare("SELECT 1 FROM messages WHERE lobby_id = ? AND anon_id = ? LIMIT 1").get(lobbyId, anonId));
}

function snapshot(reportedId, username, lobby) {
  const conn = db.get();
  const games = conn.prepare("SELECT game, rank FROM profile_games WHERE anon_id = ? ORDER BY game")
    .all(reportedId).map((g) => ({ game: g.game, rank: g.rank }));
  const out = { username, games, lobby: null, messages: [] };
  if (!lobby) return out;
  out.lobby = { game: lobby.game, createdAt: lobby.created_at, closedAt: lobby.closed_at };
  const rows = conn.prepare(`
    SELECT anon_id, body, created_at FROM (
      SELECT id, anon_id, body, created_at FROM messages WHERE lobby_id = ? ORDER BY id DESC LIMIT ?
    ) ORDER BY id
  `).all(lobby.id, SNAPSHOT_MESSAGES);
  const names = new Map([[reportedId, username]]);
  for (const m of rows) {
    if (!names.has(m.anon_id)) names.set(m.anon_id, `Player ${names.size}`);
    out.messages.push({
      who: names.get(m.anon_id), reported: m.anon_id === reportedId, body: m.body, createdAt: m.created_at,
    });
  }
  return out;
}

// Files a report. `lobbyId` is optional: without it, the report is about the
// student's profile (e.g. an offensive username) and has no chat.
function report(reporterId, input) {
  if (!input || typeof input !== "object") throw new ValidationError("Expected a report.");
  const target = profileOf(input.username);
  if (!target) throw new ValidationError("No student with that username.");
  if (target.anon_id === reporterId) throw new ValidationError("You can't report yourself.");
  if (!REASONS.includes(input.reason)) throw new ValidationError("Pick a reason.");
  if (input.details !== undefined && input.details !== null && typeof input.details !== "string") {
    throw new ValidationError("Details must be text.");
  }
  const details = (input.details || "").trim();
  if (details.length > MAX_DETAILS) throw new ValidationError(`Details must be at most ${MAX_DETAILS} characters.`);

  const conn = db.get();
  let lobby = null;
  if (input.lobbyId !== undefined && input.lobbyId !== null && input.lobbyId !== "") {
    const lobbyId = Number(input.lobbyId);
    lobby = Number.isInteger(lobbyId) ? conn.prepare("SELECT * FROM lobbies WHERE id = ?").get(lobbyId) : null;
    if (!lobby) throw new NotFoundError("No such lobby.");
    if (!wasIn(reporterId, lobby.id)) throw new ForbiddenError("You weren't in this lobby.");
    if (!wasIn(target.anon_id, lobby.id)) throw new ValidationError("That student wasn't in this lobby.");
  }

  const lobbyId = lobby ? lobby.id : null;
  const dup = conn.prepare(`
    SELECT 1 FROM reports WHERE status = 'open' AND reporter_anon_id = ? AND reported_anon_id = ? AND lobby_id IS ?
  `).get(reporterId, target.anon_id, lobbyId);
  if (dup) throw new ValidationError("You've already reported this. A moderator will look at it soon.");
  const { n } = conn.prepare(`
    SELECT COUNT(*) AS n FROM reports WHERE reporter_anon_id = ? AND created_at > datetime('now', '-1 day')
  `).get(reporterId);
  if (n >= MAX_REPORTS_PER_DAY) throw new ValidationError("You've sent a lot of reports today. Try again tomorrow.");

  const { lastInsertRowid } = conn.prepare(`
    INSERT INTO reports (reporter_anon_id, reported_anon_id, lobby_id, reason, details, snapshot)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(reporterId, target.anon_id, lobbyId, input.reason, details || null,
    JSON.stringify(snapshot(target.anon_id, target.username, lobby)));
  return Number(lastInsertRowid);
}

function requireModerator(anonId) {
  const account = accounts.find(anonId);
  if (!account || !account.isModerator) throw new ForbiddenError("Moderators only.");
}

// Open reports, oldest first. A moderator never sees reports they filed or
// reports about themselves; another moderator handles those.
function queue(modId) {
  requireModerator(modId);
  const conn = db.get();
  const rows = conn.prepare(`
    SELECT r.*, p.username AS current_username FROM reports r
    LEFT JOIN profiles p ON p.anon_id = r.reported_anon_id
    WHERE r.status = 'open' AND r.reported_anon_id <> ? AND r.reporter_anon_id <> ?
    ORDER BY r.created_at, r.id LIMIT 100
  `).all(modId, modId);
  const one = (sql, ...args) => Number(conn.prepare(sql).get(...args).n);
  return rows.map((r) => {
    const snap = JSON.parse(r.snapshot || "{}");
    return {
      id: r.id,
      createdAt: r.created_at,
      reason: r.reason,
      details: r.details,
      username: r.current_username || snap.username || null,
      usernameWhenReported: snap.username || null,
      accountDeleted: !r.current_username,
      games: snap.games || [],
      lobby: snap.lobby || null,
      messages: snap.messages || [],
      // Context only. Nothing here says who the reporter is.
      flags: {
        reporterReportsLast30Days: one(`SELECT COUNT(*) AS n FROM reports
          WHERE reporter_anon_id = ? AND created_at > datetime('now', '-30 days')`, r.reporter_anon_id),
        reporterDismissed: one(`SELECT COUNT(*) AS n FROM reports
          WHERE reporter_anon_id = ? AND action = 'dismissed'`, r.reporter_anon_id),
        openReportsAboutThem: one(`SELECT COUNT(DISTINCT reporter_anon_id) AS n FROM reports
          WHERE reported_anon_id = ? AND status = 'open'`, r.reported_anon_id),
        pastWarnings: one(`SELECT COUNT(*) AS n FROM warnings WHERE anon_id = ?`, r.reported_anon_id),
      },
    };
  });
}

// Resolves a report: dismiss (no action), warn (they see a notice next
// time), or ban (they're signed out and can't sign in again). A ban
// resolves every open report about that student.
// Returns the reported anon ID if they were banned, so live connections can be closed.
function resolve(modId, reportId, action) {
  requireModerator(modId);
  const outcome = ACTIONS[action];
  if (!outcome) throw new ValidationError("Action must be dismiss, warn, or ban.");
  const conn = db.get();
  const r = conn.prepare("SELECT * FROM reports WHERE id = ?").get(Number(reportId));
  if (!r) throw new NotFoundError("No such report.");
  if (r.status !== "open") throw new ValidationError("This report was already resolved.");
  if (r.reported_anon_id === modId || r.reporter_anon_id === modId) {
    throw new ForbiddenError("Another moderator needs to handle this one.");
  }

  if (outcome === "banned") {
    // Leave their lobby the normal way first (closes it if they host).
    const active = lobbies.activeLobbyId(r.reported_anon_id);
    if (active) lobbies.leave(r.reported_anon_id, active);
  }
  conn.exec("BEGIN");
  try {
    const close = conn.prepare(`
      UPDATE reports SET status = 'resolved', resolved_at = datetime('now'), resolved_by = ?, action = ?,
        snapshot = NULL, details = NULL
      WHERE id = ?
    `);
    close.run(modId, outcome, r.id);
    if (outcome === "warned") {
      conn.prepare("INSERT INTO warnings (anon_id, reason) VALUES (?, ?)").run(r.reported_anon_id, r.reason);
    }
    if (outcome === "banned") {
      accounts.setBanned(r.reported_anon_id, true);
      const others = conn.prepare("SELECT id FROM reports WHERE status = 'open' AND reported_anon_id = ?")
        .all(r.reported_anon_id);
      for (const o of others) close.run(modId, outcome, o.id);
    }
    conn.exec("COMMIT");
  } catch (err) {
    conn.exec("ROLLBACK");
    throw err;
  }
  return outcome === "banned" ? r.reported_anon_id : null;
}

// Banned students who still have a profile, so a moderator can lift a ban
// (e.g. after an appeal).
function bannedList(modId) {
  requireModerator(modId);
  return db.get().prepare(`
    SELECT p.username FROM accounts a JOIN profiles p ON p.anon_id = a.anon_id
    WHERE a.banned = 1 ORDER BY p.username
  `).all().map((r) => r.username);
}

function unban(modId, username) {
  requireModerator(modId);
  const row = typeof username === "string" &&
    db.get().prepare("SELECT anon_id FROM profiles WHERE username = ?").get(username.trim());
  if (!row) throw new NotFoundError("No student with that username.");
  accounts.setBanned(row.anon_id, false);
}

// Recently resolved reports, for moderators to keep each other accountable.
// The evidence is gone by now; this is just what was decided and by whom.
function history(modId) {
  requireModerator(modId);
  return db.get().prepare(`
    SELECT r.reason, r.action, r.resolved_at AS resolvedAt, p.username AS moderator
    FROM reports r LEFT JOIN profiles p ON p.anon_id = r.resolved_by
    WHERE r.status = 'resolved' ORDER BY r.resolved_at DESC, r.id DESC LIMIT 30
  `).all().map((r) => ({ ...r }));
}

// The oldest warning you haven't seen yet, or null.
function pendingWarning(anonId) {
  const row = db.get().prepare(`
    SELECT id, reason, created_at AS createdAt FROM warnings WHERE anon_id = ? AND seen_at IS NULL ORDER BY id LIMIT 1
  `).get(anonId);
  return row ? { ...row } : null;
}

function ackWarnings(anonId) {
  db.get().prepare("UPDATE warnings SET seen_at = datetime('now') WHERE anon_id = ? AND seen_at IS NULL").run(anonId);
}

module.exports = {
  REASONS, report, queue, resolve, bannedList, unban, history, pendingWarning, ackWarnings,
};
