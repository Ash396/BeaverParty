// Ask the server if it's up and show the result on the page.
fetch("/api/health")
  .then((res) => res.json())
  .then((data) => { document.getElementById("status").textContent = data.status; })
  .catch(() => { document.getElementById("status").textContent = "unreachable"; });

// Show the log in or log out button.
fetch("/api/me")
  .then((res) => res.json())
  .then((me) => {
    const id = !me.authEnabled ? "auth-off" : me.signedIn ? "signed-in" : "signed-out";
    document.getElementById(id).hidden = false;
  })
  .catch(() => {});
