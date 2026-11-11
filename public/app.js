// Ask the server if it's up and show the result on the page.
fetch("/api/health")
  .then((res) => res.json())
  .then((data) => { document.getElementById("status").textContent = data.status; })
  .catch(() => { document.getElementById("status").textContent = "unreachable"; });
