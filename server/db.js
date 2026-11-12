// The SQLite database. Uses Node's built-in node:sqlite, so there is still
// nothing to install. Every table refers to people only by anonymous ID;
// no table holds a kerb, email, or Touchstone name.
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

// Each entry runs once, in order. To change the schema, add a new entry at
// the end; never edit one that has already shipped.
const MIGRATIONS = [
  `
  CREATE TABLE accounts (
    anon_id      TEXT PRIMARY KEY,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    banned       INTEGER NOT NULL DEFAULT 0,
    is_moderator INTEGER NOT NULL DEFAULT 0
  );

  -- Username and games are always shown; everything else is opt-in.
  -- Edits overwrite in place, so there is no profile history.
  CREATE TABLE profiles (
    anon_id    TEXT PRIMARY KEY REFERENCES accounts(anon_id) ON DELETE CASCADE,
    username   TEXT NOT NULL UNIQUE COLLATE NOCASE,
    real_name  TEXT,
    dorm       TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- In-game names are only shown to members of a lobby for that game.
  CREATE TABLE profile_games (
    anon_id      TEXT NOT NULL REFERENCES accounts(anon_id) ON DELETE CASCADE,
    game         TEXT NOT NULL,
    rank         TEXT,
    in_game_name TEXT,
    PRIMARY KEY (anon_id, game)
  );

  CREATE TABLE lobbies (
    id             INTEGER PRIMARY KEY,
    host_anon_id   TEXT NOT NULL REFERENCES accounts(anon_id),
    game           TEXT NOT NULL,
    slots          INTEGER NOT NULL CHECK (slots > 0),
    vibe           TEXT,
    rank           TEXT,
    voice          INTEGER NOT NULL DEFAULT 0,
    discord_invite TEXT,
    state          TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'full', 'closed')),
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at      TEXT
  );

  CREATE TABLE lobby_members (
    lobby_id  INTEGER NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
    anon_id   TEXT NOT NULL REFERENCES accounts(anon_id),
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (lobby_id, anon_id)
  );

  -- Lobby chat. Deleted a while after the lobby closes, unless reported
  -- (reports keep their own copy).
  CREATE TABLE messages (
    id         INTEGER PRIMARY KEY,
    lobby_id   INTEGER NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
    anon_id    TEXT NOT NULL REFERENCES accounts(anon_id),
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE endorsements (
    from_anon_id TEXT NOT NULL REFERENCES accounts(anon_id),
    to_anon_id   TEXT NOT NULL REFERENCES accounts(anon_id),
    lobby_id     INTEGER NOT NULL REFERENCES lobbies(id),
    badge        TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (from_anon_id, to_anon_id, lobby_id, badge),
    CHECK (from_anon_id <> to_anon_id)
  );

  -- The reporter is never shown to the reported user, but is stored so
  -- moderators can spot mass or false reporting. The snapshot is a copy of
  -- what was reported (username, messages), kept until the report is resolved.
  CREATE TABLE reports (
    id               INTEGER PRIMARY KEY,
    reporter_anon_id TEXT NOT NULL REFERENCES accounts(anon_id),
    reported_anon_id TEXT NOT NULL REFERENCES accounts(anon_id),
    lobby_id         INTEGER REFERENCES lobbies(id),
    reason           TEXT NOT NULL,
    snapshot         TEXT,
    status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at      TEXT
  );
  `,
  // 2: indexes for lobby lookups.
  `
  CREATE INDEX lobbies_state ON lobbies(state);
  CREATE INDEX lobby_members_anon ON lobby_members(anon_id);
  CREATE INDEX messages_lobby ON messages(lobby_id, id);
  `,
  // 3: pixel beaver avatars (see catalog.js).
  `
  ALTER TABLE profiles ADD COLUMN avatar_color TEXT NOT NULL DEFAULT 'brown';
  ALTER TABLE profiles ADD COLUMN avatar_item TEXT NOT NULL DEFAULT 'none';
  `,
  // 4: "appear offline" setting (see presence.js). Online status itself is
  // kept in memory only, so there is no last-seen history.
  `
  ALTER TABLE profiles ADD COLUMN invisible INTEGER NOT NULL DEFAULT 0;
  `,
  // 5: blocking, report details and outcomes, and warnings.
  `
  -- The blocked student is never told. See blocks.js for what a block does.
  CREATE TABLE blocks (
    blocker_anon_id TEXT NOT NULL REFERENCES accounts(anon_id) ON DELETE CASCADE,
    blocked_anon_id TEXT NOT NULL REFERENCES accounts(anon_id) ON DELETE CASCADE,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (blocker_anon_id, blocked_anon_id),
    CHECK (blocker_anon_id <> blocked_anon_id)
  );
  CREATE INDEX blocks_blocked ON blocks(blocked_anon_id);

  -- reason is one of moderation.REASONS; details is the reporter's own words.
  -- On resolve, snapshot and details are deleted; reason, action, and who
  -- resolved it stay so repeat problems and mass reporting can be counted.
  ALTER TABLE reports ADD COLUMN details TEXT;
  ALTER TABLE reports ADD COLUMN action TEXT CHECK (action IN ('dismissed', 'warned', 'banned'));
  ALTER TABLE reports ADD COLUMN resolved_by TEXT;
  CREATE INDEX reports_status ON reports(status, created_at);
  CREATE INDEX reports_reported ON reports(reported_anon_id);
  CREATE INDEX reports_reporter ON reports(reporter_anon_id, created_at);

  -- Shown to the student once, on their next visit.
  CREATE TABLE warnings (
    id         INTEGER PRIMARY KEY,
    anon_id    TEXT NOT NULL REFERENCES accounts(anon_id) ON DELETE CASCADE,
    reason     TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    seen_at    TEXT
  );
  `,
  // 6: friends (see friends.js). One row per pair: a pending request until
  // the other student accepts it.
  `
  CREATE TABLE friends (
    from_anon_id TEXT NOT NULL REFERENCES accounts(anon_id) ON DELETE CASCADE,
    to_anon_id   TEXT NOT NULL REFERENCES accounts(anon_id) ON DELETE CASCADE,
    accepted     INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    accepted_at  TEXT,
    PRIMARY KEY (from_anon_id, to_anon_id),
    CHECK (from_anon_id <> to_anon_id)
  );
  CREATE INDEX friends_to ON friends(to_anon_id);
  `,
];

let db = null;

function open(dbPath) {
  close();
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  migrate(db);
  return db;
}

function migrate(database) {
  const { user_version: current } = database.prepare("PRAGMA user_version").get();
  for (let v = current; v < MIGRATIONS.length; v++) {
    database.exec("BEGIN");
    try {
      database.exec(MIGRATIONS[v]);
      database.exec(`PRAGMA user_version = ${v + 1}`);
      database.exec("COMMIT");
    } catch (err) {
      database.exec("ROLLBACK");
      throw err;
    }
  }
}

function close() {
  if (db) db.close();
  db = null;
}

function get() {
  if (!db) throw new Error("database not opened; call db.open() first");
  return db;
}

module.exports = { open, close, get };
