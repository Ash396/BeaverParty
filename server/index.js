// BeaverParty server: serves public/, a health check, and MIT sign-in.
// Uses only Node's built-in modules, so there is nothing to install.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { loadConfig } = require("./config");
const auth = require("./auth");
const db = require("./db");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };

function createServer(config) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");

    try {
      if (await auth.handle(config, req, res, url)) return;
    } catch (err) {
      console.error(err);
      res.writeHead(500);
      return res.end("Server error");
    }

    if (url.pathname === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ status: "ok" }));
    }

    const file = path.join(PUBLIC_DIR, url.pathname === "/" ? "index.html" : url.pathname);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403);
      return res.end("Forbidden");
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end("Not found");
      }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    });
  });
}

if (require.main === module) {
  const config = loadConfig();
  db.open(config.dbPath);
  if (!config.authEnabled) {
    console.warn(`Sign-in is off. Missing: ${config.missing.join(", ")}. See .env.example.`);
  }
  createServer(config).listen(config.port, () => console.log(`BeaverParty running at ${config.baseUrl}`));
}

module.exports = { createServer };
