// Deleting your account. Removes your profile, games, avatar, chat messages,
// lobby memberships, lobbies you hosted, endorsements you gave or got,
// blocks in either direction, and warnings.
//
// The account row itself (anonymous ID, join date, banned and moderator
// flags; nothing else) is removed too, unless a report that names you is
// still open. Then the row stays until the report is resolved, so a
// moderator can still ban that ID and deleting can't be used to escape a
// report. (A banned student can't sign in, so they can't delete at all.)
const db = require("./db");
const lobbies = require("./lobbies");

function deleteAccount(anonId) {
  const conn = db.get();
  // Leave your current lobby the normal way first (closes it if you host).
  const active = lobbies.activeLobbyId(anonId);
  if (active) lobbies.leave(anonId, active);

  const keepRow = Boolean(conn.prepare(`
    SELECT 1 FROM reports WHERE status = 'open' AND (reported_anon_id = ? OR reporter_anon_id = ?)
  `).get(anonId, anonId));

  conn.exec("BEGIN");
  try {
    const hosted = "SELECT id FROM lobbies WHERE host_anon_id = ?";
    conn.prepare(`DELETE FROM endorsements WHERE from_anon_id = ? OR to_anon_id = ? OR lobby_id IN (${hosted})`)
      .run(anonId, anonId, anonId);
    conn.prepare("DELETE FROM messages WHERE anon_id = ?").run(anonId);
    conn.prepare("DELETE FROM blocks WHERE blocker_anon_id = ? OR blocked_anon_id = ?").run(anonId, anonId);
    conn.prepare("DELETE FROM warnings WHERE anon_id = ?").run(anonId);
    conn.prepare("UPDATE reports SET resolved_by = NULL WHERE resolved_by = ?").run(anonId);
    conn.prepare("DELETE FROM lobby_members WHERE anon_id = ?").run(anonId);
    conn.prepare("DELETE FROM reports WHERE status = 'resolved' AND (reported_anon_id = ? OR reporter_anon_id = ?)")
      .run(anonId, anonId);
    if (!keepRow) {
      // Lobbies point at their host, so they go too (with their chat).
      conn.prepare(`UPDATE reports SET lobby_id = NULL WHERE lobby_id IN (${hosted})`).run(anonId);
      conn.prepare("DELETE FROM lobbies WHERE host_anon_id = ?").run(anonId);
    }
    conn.prepare("DELETE FROM profile_games WHERE anon_id = ?").run(anonId);
    conn.prepare("DELETE FROM profiles WHERE anon_id = ?").run(anonId);
    if (!keepRow) conn.prepare("DELETE FROM accounts WHERE anon_id = ?").run(anonId);
    conn.exec("COMMIT");
  } catch (err) {
    conn.exec("ROLLBACK");
    throw err;
  }
  return { keptIdForOpenReport: keepRow };
}

module.exports = { deleteAccount };
