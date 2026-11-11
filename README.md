# BeaverParty

A campus gaming app for MIT students: find people to play with, join lobbies, and see who's online. Team project for MIT 6.1850 (Computer Systems and Society).

This is starter scaffolding only. It runs a tiny web server that serves a placeholder page and one health-check endpoint, with no dependencies to install.

## Run it locally

You need [Node.js](https://nodejs.org/) 18 or newer.

```sh
npm start
```

Then open http://localhost:3000. A health check is at http://localhost:3000/api/health.

## Layout

```
public/     The web page (HTML, CSS, JS) the browser loads
server/     The Node.js server (serves public/ and the /api routes)
```

## Next steps

The proposal describes six services (Auth, Profile, Lobby, Presence, Endorsement, Moderation). We'll pick a framework and database before building those out.
