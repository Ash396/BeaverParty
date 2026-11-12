// Send signed-in users to the app; otherwise show the login button.
fetch("/api/me")
  .then((res) => res.json())
  .then((me) => {
    if (me.signedIn) return location.replace("/app.html");
    document.getElementById(me.authEnabled ? "signed-out" : "auth-off").hidden = false;
  })
  .catch(() => { document.getElementById("signed-out").hidden = false; });

// Background: dots and hexagons in the team palette, drifting slowly.
// Drawn once and left still for people who ask for reduced motion.
(function sky() {
  const canvas = document.getElementById("sky");
  const ctx = canvas.getContext("2d");
  const COLORS = ["#FF6A4D", "#FFC14D", "#4CFCA7", "#4D6AFF"];
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let shapes = [];
  let width = 0, height = 0;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    width = innerWidth; height = innerHeight;
    canvas.width = width * dpr; canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.round(Math.min(90, (width * height) / 14000));
    shapes = Array.from({ length: count }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      r: 3 + Math.random() * (Math.random() < 0.2 ? 18 : 7),
      hex: Math.random() < 0.3,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      dx: (Math.random() - 0.5) * 0.3,
      dy: (Math.random() - 0.5) * 0.3,
      spin: (Math.random() - 0.5) * 0.004,
      angle: Math.random() * Math.PI,
      alpha: 0.35 + Math.random() * 0.5,
    }));
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);
    const light = document.documentElement.dataset.theme === "light";
    for (const s of shapes) {
      ctx.globalAlpha = light ? s.alpha * 0.7 : s.alpha;
      ctx.beginPath();
      if (s.hex) {
        for (let i = 0; i < 6; i++) {
          const a = s.angle + (i * Math.PI) / 3;
          ctx[i ? "lineTo" : "moveTo"](s.x + s.r * Math.cos(a), s.y + s.r * Math.sin(a));
        }
        ctx.closePath();
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = s.color;
        ctx.fill();
      }
    }
  }

  function step() {
    for (const s of shapes) {
      s.x += s.dx; s.y += s.dy; s.angle += s.spin;
      if (s.x < -30) s.x = width + 30; else if (s.x > width + 30) s.x = -30;
      if (s.y < -30) s.y = height + 30; else if (s.y > height + 30) s.y = -30;
    }
    draw();
    requestAnimationFrame(step);
  }

  resize();
  addEventListener("resize", () => { resize(); if (still) draw(); });
  document.addEventListener("themechange", draw);
  if (still) draw(); else requestAnimationFrame(step);
})();
