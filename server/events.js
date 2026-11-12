// Live updates over Server-Sent Events (SSE): the browser keeps one HTTP
// request open and the server writes events to it. Two kinds of channel:
//   "lobbies"     -> the open-lobby list changed (everyone signed in)
//   "lobby:<id>"  -> a lobby's members, state, or chat changed (members only)

const channels = new Map(); // channel -> Set of { res, anonId }

function subscribe(res, anonId, names) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");
  const sub = { res, anonId, names };
  for (const name of names) {
    if (!channels.has(name)) channels.set(name, new Set());
    channels.get(name).add(sub);
  }
  // Comments keep proxies from closing an idle connection.
  sub.ping = setInterval(() => write(sub, ": ping\n\n"), 25_000);
  res.on("close", () => remove(sub));
}

function write(sub, text) {
  if (!sub.res.writableEnded) sub.res.write(text);
}

function remove(sub) {
  clearInterval(sub.ping);
  for (const name of sub.names) channels.get(name)?.delete(sub);
}

// `except` is a set of anon IDs who shouldn't get this event (e.g. people
// who blocked the sender of a chat message).
function publish(name, event, data = {}, except = null) {
  const subs = channels.get(name);
  if (!subs) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const sub of subs) if (!except || !except.has(sub.anonId)) write(sub, payload);
}

// Cut someone off from a lobby's channel, e.g. after they leave it.
function kick(name, anonId) {
  const subs = channels.get(name);
  if (!subs) return;
  for (const sub of [...subs]) {
    if (sub.anonId === anonId) {
      remove(sub);
      sub.res.end();
    }
  }
}

// Close every live connection someone has, e.g. after they delete their account.
function kickEverywhere(anonId) {
  for (const name of [...channels.keys()]) kick(name, anonId);
}

function closeAll() {
  for (const subs of channels.values()) {
    for (const sub of subs) {
      clearInterval(sub.ping);
      sub.res.end();
    }
  }
  channels.clear();
}

module.exports = { subscribe, publish, kick, kickEverywhere, closeAll };
