// Pixel beaver avatars, drawn as SVG from a 24x24 grid. An avatar is a fur
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

// A sitting beaver on a 24x24 grid, tail to the right.
// O outline, F fur, L belly and muzzle, A paws, K eyes, W white (eye shine,
// teeth), N nose, P blush, D/X tail crosshatch, . empty
const BEAVER = [
  "........................",
  "...OO..........OO.......",
  "..OLLOOOOOOOOOOLLO......",
  "..OFFFFFFFFFFFFFFO......",
  ".OFFFFFFFFFFFFFFFFO.....",
  ".OFFFFFFFFFFFFFFFFO.....",
  "OFFFFFFFFFFFFFFFFFFO....",
  "OFFFWKFFFFFFFFWKFFFO....",
  "OFFFKKFFFFFFFFKKFFFO....",
  "OFFFKKFFFFFFFFKKFFFO....",
  "OFFPPFFLLNNLLFFPPFFO....",
  ".OFFFFLLLLLLLLFFFFO.....",
  ".OFFFFFLLWWLLFFFFFO.....",
  "..OOFFFFLWWLFFFFOO......",
  "...OFFFFFFFFFFFFO..OOOO.",
  "..OFFLLLLLLLLLLFFO.ODDDO",
  "..OFAALLLLLLLLAAFOODXDXO",
  ".OFFAALLLLLLLLAAFFOXDXDO",
  ".OFFFLLLLLLLLLLFFFODXDXO",
  ".OFFFFLLLLLLLLFFFFOXDXDO",
  "..OFFFFLLLLLLFFFFOOODDO.",
  "..OOFFFFFFFFFFFFOO..OO..",
  "...OLLLO....OLLLO.......",
  "....OOO......OOO........",
];

// Accessories drawn on top, same grid. Letters map to ITEM_COLORS.
const ITEMS = {
  none: [],
  headset: [
    "....HHHHHHHHHHHH........",
    "..HH............HH......",
    ".H................H.....",
    ".H................H.....",
    "H..................H....",
    "H..................H....",
    "EE................EE....",
    "EE................EE....",
    "EE................EE....",
    "EE...............MEE....",
    "................M.......",
    "..............MM........",
  ],
  cap: [
    "....CCCCCCCCCC..........",
    "..CCCCCCCCCCCCCC........",
    "..CCCCCCCSCCCCCCC.......",
    "..BBBBBBBBBBBBBBBBBBB...",
  ],
  glasses: [
    "", "", "", "", "", "",
    "...GGGG......GGGG.......",
    "...G..GGGGGGGG..G.......",
    "...G..G......G..G.......",
    "...G..G......G..G.......",
    "...GGGG......GGGG.......",
  ],
  crown: [
    "......Y..YY..Y..........",
    "......YYYYYYYY..........",
    "......YRYYYYRY..........",
  ],
  bow: [
    "..............PP.PP.....",
    "..............PPQPP.....",
    "...............P.P......",
  ],
};
const ITEM_COLORS = {
  H: "#6B646B", E: "#4CFCA7", M: "#6B646B",
  C: "#22307A", S: "#FFFFFF", B: "#3049D9",
  G: "#1C181C",
  Y: "#FFC14D", R: "#FF6A4D",
  P: "#FF8FB1", Q: "#E0577F",
};

function mix(hex, other, amount) {
  const a = hex.match(/\w\w/g).map((h) => parseInt(h, 16));
  const b = other.match(/\w\w/g).map((h) => parseInt(h, 16));
  return "#" + a.map((v, i) => Math.round(v + (b[i] - v) * amount).toString(16).padStart(2, "0")).join("");
}

function beaverSvg(avatar, size = 48) {
  const fur = BEAVER_FUR[(avatar && avatar.color) || "brown"] || BEAVER_FUR.brown;
  const shadow = "#1C181C";
  const colors = {
    O: mix(fur, shadow, 0.55), F: fur, L: mix(fur, "#FFFFFF", 0.6), A: mix(fur, shadow, 0.2),
    D: mix(fur, shadow, 0.35), X: mix(fur, shadow, 0.5), N: mix(fur, shadow, 0.7),
    K: shadow, W: "#FFFFFF", P: "#FF8FB1",
  };
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
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
