// Pixel beaver avatars, drawn as SVG from a 16x16 grid. An avatar is a fur
// color plus an accessory, both from fixed lists (server/catalog.js).
// beaverSvg({ color, item }, size) returns an <svg> element.
const BEAVER_FUR = {
  brown: "#9A6237",
  tomato: "#FF6A4D",
  gold: "#FFC14D",
  mint: "#4CFCA7",
  sapphire: "#4D6AFF",
  grey: "#A8A3A8",
};
const AVATAR_LABELS = {
  brown: "Classic", tomato: "Tomato", gold: "Gold", mint: "Mint", sapphire: "Sapphire", grey: "Grey",
  none: "Nothing", headset: "Headset", cap: "Cap", glasses: "Glasses", crown: "Crown", bow: "Bow",
};

// F fur, D dark fur, L light muzzle, K eyes and nose, W white, . empty
const BEAVER = [
  "................",
  "...DD......DD...",
  "..DFFD....DFFD..",
  "..DFLFDDDDFLFD..",
  "...DFFFFFFFFD...",
  "..DFFFFFFFFFFD..",
  ".DFFKKFFFFKKFFD.",
  ".DFFKWFFFFKWFFD.",
  ".DFFFFFFFFFFFFD.",
  ".DFFFLLKKLLFFFD.",
  ".DFFLLLLLLLLFFD.",
  "..DFLLLWWLLLFD..",
  "..DFFLLWWLLFFD..",
  "...DFFLLLLFFD...",
  "....DDFFFFDD....",
  "......DDDD......",
];

// Accessories drawn on top. Letters map to colors in ITEM_COLORS.
const ITEMS = {
  none: [],
  headset: [
    "....HHHHHHHH....",
    "...H........H...",
    "..H..........H..",
    "..H..........H..",
    "................",
    "................",
    "HH............HH",
    "HE............EH",
    "HE............EH",
    "HH...........MHH",
    "............M...",
    "...........M....",
  ],
  cap: [
    "................",
    "....CCCCCCCC....",
    "...CCCCCCCCCC...",
    "..CCCCCCSCCCCC..",
    "..BBBBBBBBBBBBBB",
  ],
  glasses: [
    "", "", "", "", "",
    "................",
    ".GGGGGG..GGGGGG.",
    ".G....GGGG....G.",
    ".GGGGGG..GGGGGG.",
  ],
  crown: [
    "...Y...Y...Y....",
    "...YY.YYY.YY....",
    "...YYYYRYYYY....",
    "...YYYYYYYYY....",
  ],
  bow: [
    "",
    "..........PP.PP.",
    "..........PPPPP.",
    "...........PPP..",
    "..........PP.PP.",
  ],
};
const ITEM_COLORS = {
  H: "#6B646B", E: "#4CFCA7", M: "#6B646B",
  C: "#22307A", S: "#FFFFFF", B: "#3049D9",
  G: "#1C181C",
  Y: "#FFC14D", R: "#FF6A4D",
  P: "#FF8FB1",
};

function mix(hex, other, amount) {
  const a = hex.match(/\w\w/g).map((h) => parseInt(h, 16));
  const b = other.match(/\w\w/g).map((h) => parseInt(h, 16));
  return "#" + a.map((v, i) => Math.round(v + (b[i] - v) * amount).toString(16).padStart(2, "0")).join("");
}

function beaverSvg(avatar, size = 48) {
  const fur = BEAVER_FUR[(avatar && avatar.color) || "brown"] || BEAVER_FUR.brown;
  const colors = {
    F: fur, D: mix(fur, "#1C181C", 0.45), L: mix(fur, "#FFFFFF", 0.55), K: "#1C181C", W: "#FFFFFF",
  };
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("class", "avatar");
  svg.setAttribute("aria-hidden", "true");
  const paint = (rows, palette) => rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (!palette[ch]) return;
      const r = document.createElementNS(ns, "rect");
      r.setAttribute("x", x); r.setAttribute("y", y);
      r.setAttribute("width", 1); r.setAttribute("height", 1);
      r.setAttribute("fill", palette[ch]);
      svg.append(r);
    });
  });
  paint(BEAVER, colors);
  paint(ITEMS[(avatar && avatar.item) || "none"] || [], ITEM_COLORS);
  return svg;
}
