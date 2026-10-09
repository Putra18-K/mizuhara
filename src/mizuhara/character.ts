// Mizuhara's character art.
//
// The project's own sprite replaces the procedurally drawn body. Everything the
// sprite cannot say on its own — eyes, mouth, blush, head symbols — is layered
// on top in code, so a new expression costs no art. Dropping a PNG named after
// any EXPRESSIONS key (e.g. `angry.png`) into src/assets/character/ makes that
// expression use the art verbatim instead of the overlay.

import type { Badge } from "./engine";

export const BASE_KEY = "mizuhara";

// ── Landmarks (fractions of the sprite, measured from the drawing) ────────────

const EYE_L: readonly [number, number] = [0.277, 0.420];
const EYE_R: readonly [number, number] = [0.551, 0.441];
const EYE_RU = 0.082;
const EYE_RV = 0.080;
const MOUTH: readonly [number, number] = [0.410, 0.550];
const MOUTH_RU = 0.052;
const MOUTH_RV = 0.019;
const BLUSH_L: readonly [number, number] = [0.353, 0.525];
const BLUSH_R: readonly [number, number] = [0.612, 0.483];
const BLUSH_RU = 0.075;
const BLUSH_RV = 0.038;

/** Flat skin tone read off the sprite — used to erase a feature before redrawing it. */
const SKIN = "#FFE5CD";
const SKIN_RGB = "255,229,205";
const INK = "#3A221B";
const MOUTH_INK = "#7E3941";

/** Sprite width as a multiple of the engine's body radius R. */
export const SPRITE_W_R = 2.3;

// ── Assets ────────────────────────────────────────────────────────────────────

const files = import.meta.glob("../assets/character/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

interface Art {
  img: HTMLImageElement;
  ok: () => boolean;
}

const art = new Map<string, Art>();

for (const [path, url] of Object.entries(files)) {
  const key = (path.split("/").pop() ?? path).replace(/\.png$/i, "").toLowerCase();
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  art.set(key, { img, ok: () => img.complete && img.naturalWidth > 0 });
}

const baseKey: string | null = art.has(BASE_KEY)
  ? BASE_KEY
  : art.has("idle")
    ? "idle"
    : (art.keys().next().value ?? null);

let loading: Promise<void> | null = null;

/** Resolves once the base sprite exists (or immediately when there is none). */
export function loadCharacter(): Promise<void> {
  if (loading) return loading;
  const entry = baseKey ? art.get(baseKey) : undefined;
  loading = entry
    ? new Promise<void>((resolve) => {
        if (entry.ok()) {
          resolve();
          return;
        }
        entry.img.addEventListener("load", () => resolve(), { once: true });
        entry.img.addEventListener("error", () => resolve(), { once: true });
      })
    : Promise.resolve();
  return loading;
}

/** True once the sprite is decoded and the engine can draw it. */
export function hasArt(): boolean {
  const b = baseKey ? art.get(baseKey) : undefined;
  return !!b && b.ok();
}

function pick(key: string): { a: Art; overlay: boolean } | null {
  const exact = art.get(key);
  if (exact && exact.ok()) return { a: exact, overlay: false };
  const b = baseKey ? art.get(baseKey) : undefined;
  if (b && b.ok()) return { a: b, overlay: true };
  return null;
}

// ── Expressions ───────────────────────────────────────────────────────────────

export type EyeDraw =
  | "art" | "closed" | "happy" | "angry" | "wide" | "tired"
  | "spiral" | "heart" | "star" | "line";

export type MouthDraw =
  | "art" | "smile" | "small" | "grin" | "frown" | "flat" | "open" | "wavy" | "yawn";

export type SymbolKind = "anger" | "sweat" | "none";

export interface Expression {
  key: string;
  eye: EyeDraw;
  mouth: MouthDraw;
  blush: number;
  symbol: SymbolKind;
  /** Reddish wash over the art, 0…1 — sells "angry" without new art. */
  flush: number;
  /** Shut the right eye only, keeping the left one as drawn. */
  wink: boolean;
}

const NEUTRAL: Expression = {
  key: "idle", eye: "art", mouth: "art", blush: 0, symbol: "none", flush: 0, wink: false,
};

const expr = (key: string, rest: Partial<Expression> = {}): Expression => ({
  ...NEUTRAL, key, ...rest,
});

/** One entry per BotStateName + BotEmoteName. */
export const EXPRESSIONS: Record<string, Expression> = {
  // Bot states
  idle: expr("idle"),
  working: expr("working", { mouth: "small" }),
  thinking: expr("thinking", { mouth: "small", symbol: "sweat" }),
  searching: expr("searching"),
  approval: expr("approval", { eye: "wide", mouth: "open" }),
  question: expr("question", { mouth: "wavy", symbol: "sweat" }),
  error: expr("error", { eye: "angry", mouth: "frown", flush: 0.5 }),
  finished: expr("finished", { eye: "happy", mouth: "grin", blush: 0.35 }),
  ratelimit: expr("ratelimit", { eye: "tired", mouth: "small", symbol: "sweat" }),
  sleeping: expr("sleeping", { eye: "closed", mouth: "small" }),
  dizzy: expr("dizzy", { eye: "spiral", mouth: "wavy" }),
  // Emotes
  love: expr("love", { eye: "heart", mouth: "smile", blush: 1 }),
  surprised: expr("surprised", { eye: "wide", mouth: "open" }),
  proud: expr("proud", { eye: "star", mouth: "smile", blush: 0.7 }),
  wink: expr("wink", { mouth: "smile", wink: true }),
  yawn: expr("yawn", { eye: "closed", mouth: "yawn", symbol: "sweat" }),
  happy: expr("happy", { eye: "happy", mouth: "grin", blush: 0.6 }),
  annoyed: expr("annoyed", { eye: "line", mouth: "flat", symbol: "anger", flush: 0.25 }),
};

export function expressionFor(key: string): Expression {
  return EXPRESSIONS[key] ?? NEUTRAL;
}

// ── Geometry ──────────────────────────────────────────────────────────────────

/** Mouth centre, as a fraction of the sprite box. */
export const MOUTH_UV: readonly [number, number] = MOUTH;

const DEFAULT_ASPECT = 476 / 405;

/** Rendered size of the sprite for a given engine radius R. */
export function spriteSize(R: number): { w: number; h: number } {
  const b = baseKey ? art.get(baseKey) : undefined;
  const ar = b && b.ok() ? b.img.naturalHeight / b.img.naturalWidth : DEFAULT_ASPECT;
  const w = R * SPRITE_W_R;
  return { w, h: w * ar };
}

// ── Drawing ───────────────────────────────────────────────────────────────────

export interface CharLayout {
  /** Engine body radius — every sprite dimension is a multiple of it. */
  R: number;
  cx: number;
  cy: number;
  tilt: number;
  sx: number;
  sy: number;
  /** Eyelid, 1 = open, ~0 = shut (drives the blink overlay). */
  open: number;
  blush: number;
  /** Mini bots: a soft disc of the task colour behind the sprite. */
  disc: string | null;
}

const BLINK_SHUT = 0.72;

export function draw(
  x: CanvasRenderingContext2D,
  e: Expression,
  layout: CharLayout,
  artBadge: Badge | null,
  badgeS: number,
): boolean {
  const picked = pick(e.key);
  if (!picked) return false;
  const img = picked.a.img;

  // The box always follows the base sprite's aspect, so landmarks stay valid
  // even when an expression ships its own art at a different ratio.
  const { w, h } = spriteSize(layout.R);
  const ar = img.naturalWidth / img.naturalHeight;
  const dw = ar > w / h ? w : h * ar;
  const dh = ar > w / h ? w / ar : h;
  const X = (u: number) => -w / 2 + u * w;
  const Y = (v: number) => -h / 2 + v * h;

  x.save();
  x.translate(layout.cx, layout.cy);
  if (layout.tilt !== 0) x.rotate(layout.tilt);
  x.scale(layout.sx, layout.sy);

  if (layout.disc) {
    const g = x.createRadialGradient(0, 0, 0, 0, 0, h * 0.62);
    g.addColorStop(0, layout.disc);
    g.addColorStop(1, "rgba(0,0,0,0)");
    x.fillStyle = g;
    x.beginPath();
    x.arc(0, h * 0.04, h * 0.62, 0, Math.PI * 2);
    x.fill();
  }

  x.drawImage(img, -dw / 2, -dh / 2, dw, dh);

  if (picked.overlay) {
    face(x, e, layout, w, h, X, Y);
    if (e.flush > 0.01) {
      x.save();
      x.globalCompositeOperation = "source-atop";
      x.fillStyle = `rgba(255,88,88,${0.22 * e.flush})`;
      x.fillRect(-w / 2, -h / 2, w, h);
      x.restore();
    }
  }
  x.restore();

  // Badge and symbol sit outside the sprite's transform so they stay upright,
  // and therefore need the sprite box mapped into canvas coordinates.
  const wu = (u: number) => layout.cx + (u - 0.5) * w * layout.sx;
  const wv = (v: number) => layout.cy + (v - 0.5) * h * layout.sy;

  if (artBadge && badgeS > 0.01) {
    drawBadge(x, artBadge, badgeS, wu(0.14), wv(0.24), w);
  }
  if (e.symbol === "sweat") sweat(x, wu(0.9), wv(0.2), w * 0.075);
  return true;
}

// ── Face overlay ──────────────────────────────────────────────────────────────

function face(
  x: CanvasRenderingContext2D,
  e: Expression,
  layout: CharLayout,
  w: number,
  h: number,
  X: (u: number) => number,
  Y: (v: number) => number,
) {
  const ew = w * EYE_RU;
  const eh = h * EYE_RV;

  const blink = layout.open < BLINK_SHUT;
  const both: readonly [readonly [number, number], number][] = [
    [EYE_L, -1],
    [EYE_R, 1],
  ];
  for (const [p, sd] of both) {
    // A wink replaces only the right eye; the left one stays as drawn.
    const kind: EyeDraw = blink || (e.wink && sd > 0) ? "closed" : e.eye;
    if (kind === "art") continue;
    const px = X(p[0]);
    const py = Y(p[1]);
    skinPatch(x, px, py, ew * 1.25, eh * 1.3);
    eyeShape(x, kind, ew, eh, sd, px, py);
  }

  const blush = Math.max(layout.blush, e.blush);
  if (blush > 0.02) {
    for (const p of [BLUSH_L, BLUSH_R]) {
      x.save();
      x.translate(X(p[0]), Y(p[1]));
      x.scale(w * BLUSH_RU, h * BLUSH_RV);
      const g = x.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0, `rgba(255,124,146,${0.55 * blush})`);
      g.addColorStop(1, "rgba(255,124,146,0)");
      x.fillStyle = g;
      x.beginPath();
      x.arc(0, 0, 1, 0, Math.PI * 2);
      x.fill();
      x.restore();
    }
  }

  const mouthKnown = e.mouth !== "art";
  if (mouthKnown) {
    const mx = X(MOUTH[0]);
    const my = Y(MOUTH[1]);
    skinPatch(x, mx, my, w * MOUTH_RU, h * MOUTH_RV * 1.9);
    mouth(x, e.mouth, mx, my, w * MOUTH_RU, h);
  }
}

/** Erases a feature by painting flat skin over it, feathered so the edge vanishes. */
function skinPatch(
  x: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
) {
  x.save();
  x.translate(cx, cy);
  x.scale(rx, ry);
  const g = x.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0, SKIN);
  g.addColorStop(0.66, SKIN);
  g.addColorStop(1, `rgba(${SKIN_RGB},0)`);
  x.fillStyle = g;
  x.beginPath();
  x.arc(0, 0, 1, 0, Math.PI * 2);
  x.fill();
  x.restore();
}

function eyeShape(
  x: CanvasRenderingContext2D,
  kind: EyeDraw,
  ew: number,
  eh: number,
  sd: number,
  px: number,
  py: number,
) {
  x.save();
  x.translate(px, py);
  x.strokeStyle = INK;
  x.fillStyle = INK;
  x.lineCap = "round";

  switch (kind) {
    case "closed": {
      x.lineWidth = ew * 0.34;
      x.beginPath();
      x.arc(0, -eh * 0.05, ew * 0.9, Math.PI * 0.16, Math.PI * 0.84);
      x.stroke();
      break;
    }
    case "happy": {
      x.lineWidth = ew * 0.4;
      x.beginPath();
      x.arc(0, eh * 0.1, ew * 0.86, Math.PI * 1.14, Math.PI * 1.86);
      x.stroke();
      break;
    }
    case "line": {
      x.lineWidth = ew * 0.34;
      x.beginPath();
      x.moveTo(-ew * 0.8, 0);
      x.lineTo(ew * 0.8, 0);
      x.stroke();
      break;
    }
    case "wide": {
      // A small, round pupil — the anime shorthand for "startled".
      x.beginPath();
      x.ellipse(0, 0, ew * 0.58, eh * 0.58, 0, 0, Math.PI * 2);
      x.fill();
      x.fillStyle = "#FFFFFF";
      x.beginPath();
      x.arc(-ew * 0.16, -eh * 0.18, eh * 0.15, 0, Math.PI * 2);
      x.fill();
      break;
    }
    case "tired": {
      x.beginPath();
      x.ellipse(0, eh * 0.22, ew * 0.98, eh * 0.62, 0, 0, Math.PI * 2);
      x.fill();
      x.lineWidth = eh * 0.16;
      x.beginPath();
      x.moveTo(-ew * 0.95, -eh * 0.08);
      x.lineTo(ew * 0.95, -eh * 0.08);
      x.stroke();
      break;
    }
    case "angry": {
      // The classic angry squint: one hard line slanting down toward the nose.
      x.lineWidth = ew * 0.38;
      x.beginPath();
      x.moveTo(sd * ew * 0.85, -eh * 0.5);
      x.lineTo(-sd * ew * 0.85, eh * 0.3);
      x.stroke();
      break;
    }
    case "spiral": {
      const t = performance.now() / 1000;
      x.lineWidth = ew * 0.2;
      x.beginPath();
      for (let a = 0; a < 4.4 * Math.PI; a += 0.2) {
        const r = ew * 0.08 + a * ew * 0.075;
        const aa = a + t * 9 * sd;
        const qx = Math.cos(aa) * r;
        const qy = Math.sin(aa) * r;
        if (a === 0) x.moveTo(qx, qy);
        else x.lineTo(qx, qy);
      }
      x.stroke();
      break;
    }
    case "heart": {
      x.fillStyle = "#FF4D6D";
      heartPath(x, ew * 1.25);
      x.fill();
      break;
    }
    case "star": {
      x.fillStyle = "#F7B32B";
      x.rotate(performance.now() / 700 * sd);
      starPath(x, ew * 1.05, ew * 0.46);
      x.fill();
      break;
    }
    case "art":
      break;
  }
  x.restore();
}

function mouth(
  x: CanvasRenderingContext2D,
  kind: MouthDraw,
  mx: number,
  my: number,
  rw: number,
  h: number,
) {
  const r = rw;
  x.save();
  x.translate(mx, my);
  x.lineCap = "round";
  x.strokeStyle = INK;
  x.lineWidth = Math.max(1, r * 0.22);

  switch (kind) {
    case "smile":
      x.beginPath();
      x.arc(0, -r * 0.55, r * 0.95, Math.PI * 0.18, Math.PI * 0.82);
      x.stroke();
      break;
    case "small":
      x.beginPath();
      x.arc(0, -r * 0.5, r * 0.55, Math.PI * 0.18, Math.PI * 0.82);
      x.stroke();
      break;
    case "grin":
      x.beginPath();
      x.arc(0, -r * 0.6, r * 1.05, Math.PI * 0.06, Math.PI * 0.94);
      x.closePath();
      x.fillStyle = MOUTH_INK;
      x.fill();
      break;
    case "frown":
      x.beginPath();
      x.arc(0, r * 0.75, r * 0.95, Math.PI * 1.2, Math.PI * 1.8);
      x.stroke();
      break;
    case "flat":
      x.beginPath();
      x.moveTo(-r * 0.7, 0);
      x.lineTo(r * 0.7, 0);
      x.stroke();
      break;
    case "open": {
      x.beginPath();
      x.ellipse(0, 0, r * 0.62, h * 0.022, 0, 0, Math.PI * 2);
      x.fillStyle = MOUTH_INK;
      x.fill();
      x.strokeStyle = INK;
      x.lineWidth = Math.max(1, r * 0.14);
      x.stroke();
      break;
    }
    case "yawn": {
      x.beginPath();
      x.ellipse(0, 0, r * 0.8, h * 0.038, 0, 0, Math.PI * 2);
      x.fillStyle = MOUTH_INK;
      x.fill();
      x.strokeStyle = INK;
      x.lineWidth = Math.max(1, r * 0.14);
      x.stroke();
      break;
    }
    case "wavy":
      x.lineWidth = Math.max(1, r * 0.2);
      x.beginPath();
      x.moveTo(-r * 0.8, 0);
      x.quadraticCurveTo(-r * 0.4, -r * 0.5, 0, 0);
      x.quadraticCurveTo(r * 0.4, r * 0.5, r * 0.8, 0);
      x.stroke();
      break;
    case "art":
      break;
  }
  x.restore();
}

/** The four-stroke anger cross (十). */
function angerCross(x: CanvasRenderingContext2D, cx: number, cy: number, s: number) {
  x.save();
  x.translate(cx, cy);
  x.strokeStyle = "#F4505E";
  x.lineWidth = Math.max(1.4, s * 0.3);
  x.lineCap = "round";
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    x.beginPath();
    x.moveTo(Math.cos(a) * s * 0.3, Math.sin(a) * s * 0.3);
    x.lineTo(Math.cos(a) * s, Math.sin(a) * s);
    x.stroke();
  }
  x.restore();
}

/** A sweat drop, drawn beside the head. */
function sweat(x: CanvasRenderingContext2D, cx: number, cy: number, s: number) {
  x.save();
  x.translate(cx, cy);
  x.fillStyle = "#7CC7FF";
  x.beginPath();
  x.moveTo(0, -s);
  x.quadraticCurveTo(s * 0.85, s * 0.25, 0, s * 0.7);
  x.quadraticCurveTo(-s * 0.85, s * 0.25, 0, -s);
  x.fill();
  x.restore();
}

function drawBadge(
  x: CanvasRenderingContext2D,
  badge: Badge,
  s: number,
  bx: number,
  by: number,
  spriteW: number,
) {
  const R = spriteW * 0.07;
  const t = performance.now() / 1000;
  const col = `rgba(${Math.round(badge.color[0] * 255)},${Math.round(
    badge.color[1] * 255,
  )},${Math.round(badge.color[2] * 255)},1)`;

  x.save();
  x.translate(bx, by);
  x.scale(s, s);

  if (badge.kind === "anger") {
    angerCross(x, 0, 0, R * 3.2);
  } else if (badge.kind === "dots") {
    const pw = R * 3.4;
    const ph = R * 1.7;
    roundRect(x, -pw / 2, -ph / 2, pw, ph, ph / 2);
    x.fillStyle = col;
    x.fill();
    for (let i = 0; i < 3; i++) {
      const phase = (((t * 2.4 - i * 0.22) % 1) + 1) % 1;
      const dotR = R * 0.26 * (1 + 0.4 * Math.max(0, Math.sin(phase * Math.PI * 2)));
      x.fillStyle = "#fff";
      x.beginPath();
      x.arc((i - 1) * R * 0.85, 0, dotR, 0, Math.PI * 2);
      x.fill();
    }
  } else {
    x.fillStyle = "#000";
    x.beginPath();
    x.arc(0, 0, R * 1.45, 0, Math.PI * 2);
    x.fill();
    x.fillStyle = col;
    x.beginPath();
    x.arc(0, 0, R * 1.1, 0, Math.PI * 2);
    x.fill();
    if (badge.kind === "bang" || badge.kind === "question") {
      x.fillStyle = "#fff";
      x.font = `900 ${R * 1.6}px ${FONT}`;
      x.textAlign = "center";
      x.textBaseline = "middle";
      x.fillText(badge.kind === "bang" ? "!" : "?", 0, R * 0.1);
    }
  }
  x.restore();
}

// ── Small path helpers ────────────────────────────────────────────────────────

const FONT = `system-ui, "Segoe UI Variable Text", "Segoe UI", sans-serif`;

function roundRect(
  x: CanvasRenderingContext2D,
  X: number, Y: number, W: number, H: number, R: number,
) {
  const r = Math.max(0, Math.min(R, W / 2, H / 2));
  x.beginPath();
  x.moveTo(X + r, Y);
  x.arcTo(X + W, Y, X + W, Y + H, r);
  x.arcTo(X + W, Y + H, X, Y + H, r);
  x.arcTo(X, Y + H, X, Y, r);
  x.arcTo(X, Y, X + W, Y, r);
  x.closePath();
}

function heartPath(x: CanvasRenderingContext2D, s: number) {
  x.beginPath();
  x.moveTo(0, s * 0.38);
  x.bezierCurveTo(-s * 1.05, -s * 0.15, -s * 0.5, -s * 0.95, 0, -s * 0.38);
  x.bezierCurveTo(s * 0.5, -s * 0.95, s * 1.05, -s * 0.15, 0, s * 0.38);
  x.closePath();
}

function starPath(x: CanvasRenderingContext2D, ro: number, ri: number) {
  x.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? ri : ro;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    x.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  x.closePath();
}
