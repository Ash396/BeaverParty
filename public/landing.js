// Send signed-in users to the app; otherwise show the login button.
fetch("/api/me")
  .then((res) => res.json())
  .then((me) => {
    if (me.signedIn) return location.replace("/app.html");
    document.getElementById(me.authEnabled ? "signed-out" : "auth-off").hidden = false;
  })
  .catch(() => { document.getElementById("signed-out").hidden = false; });
