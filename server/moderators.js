// Moderator list from the server's settings: MODERATORS=a@mit.edu,b@mit.edu
// Lets us add or remove moderators on Hyades with `edit` and `restart`,
// since `exec` can't run commands in our app (it runs as a non-root user).
//
// When MODERATORS is set, it is the whole list: everyone on it becomes a
// moderator and everyone else stops being one. When it isn't set, nothing
// changes, and `npm run set-moderator` stays the way to manage moderators.
// The emails are only used to compute anonymous IDs; they aren't stored.
const { anonIdFor } = require("./auth");
const db = require("./db");
const accounts = require("./accounts");

async function sync(config) {
  if (!config.moderators) return null;
  // Look up every ID before changing anything, so a Key Service hiccup
  // can't leave us with half a list or no moderators.
  const ids = [];
  for (const email of config.moderators) ids.push(await anonIdFor(config, email));
  db.get().exec("BEGIN");
  try {
    db.get().prepare("UPDATE accounts SET is_moderator = 0").run();
    for (const id of ids) accounts.setModerator(id, true);
    db.get().exec("COMMIT");
  } catch (err) {
    db.get().exec("ROLLBACK");
    throw err;
  }
  return ids.length;
}

// At startup the Key Service may not be up yet, so retry once a minute.
function syncWithRetry(config, triesLeft = 10) {
  sync(config).then((n) => {
    if (n !== null) console.log(`Moderators set from MODERATORS: ${n}.`);
  }).catch((err) => {
    console.error(`Couldn't set moderators from MODERATORS: ${err.message}`);
    if (triesLeft > 1) setTimeout(() => syncWithRetry(config, triesLeft - 1), 60_000).unref();
  });
}

module.exports = { sync, syncWithRetry };
