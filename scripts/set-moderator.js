// Makes someone a moderator (or removes them with --remove).
// Usage: npm run set-moderator -- someone@mit.edu [--remove]
// The email is only used to compute the anonymous ID; it isn't stored.
const { loadConfig } = require("../server/config");
const { anonIdFor } = require("../server/auth");
const db = require("../server/db");
const accounts = require("../server/accounts");

const email = (process.argv[2] || "").trim().toLowerCase();
const remove = process.argv.includes("--remove");
if (!email.includes("@")) {
  console.error("Usage: npm run set-moderator -- someone@mit.edu [--remove]");
  process.exit(1);
}
const config = loadConfig();
if (!config.anonIdKey && !config.keyServiceUrl) {
  console.error("Set ANON_ID_KEY, or KEY_SERVICE_URL and KEY_SERVICE_TOKEN, like the running server.");
  process.exit(1);
}
anonIdFor(config, email).then((anonId) => {
  db.open(config.dbPath);
  accounts.setModerator(anonId, !remove);
  console.log(remove ? "Removed moderator." : "Added moderator.");
}).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
