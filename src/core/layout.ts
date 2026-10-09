// Island geometry — ported from IslandTypes.swift + IslandWindowController.islandSize
// + IslandRootView.botPosition. All values are logical pixels, identical to the
// macOS app's points.

export type IslandMode = "hidden" | "compact" | "expanded";

export type IslandViewName =
  | "overview"
  | "empty"
  | "approval"
  | "question"
  | "error"
  | "finished"
  | "confused"
  | "upload"
  | "uploading"
  | "choose"
  | "mail"
  | "prompt"
  | "searching"
  | "result"
  | "note"
  | "settings"
  | "sessions"
  | "greeting";

export type BotStateName =
  | "idle"
  | "working"
  | "thinking"
  | "searching"
  | "approval"
  | "question"
  | "error"
  | "finished"
  | "ratelimit"
  | "sleeping"
  | "dizzy";

export type BotEmoteName = "love" | "surprised" | "proud" | "wink" | "yawn" | "happy" | "annoyed";

export type AgentLayoutMode = "none" | "grid" | "pills" | "column";

export interface ViewLayout {
  height: number;
  botX: number;
  botY: number | null; // null = auto-centred
  botDiameter: number;
  agentMode: AgentLayoutMode;
}

// The window is a fixed 640×520 transparent stage at the right edge of the screen,
// vertically centred. It stays 640 wide so the launch greeting and the file-drop
// choreography (both drawn on a 640-wide canvas) still fit; the *visible* island
// for normal views is the narrow portrait column below.
export const PANEL_W = 640;
export const PANEL_H = 420;
/** Width of the visible island for normal (portrait) views. */
export const ISLAND_W = 288;

// No notch on a PC: these are the hidden/compact sizes from docs/SPEC.md.
export const NOTCH_W = 184;
export const NOTCH_H = 32;
export const COMPACT_W = 288; // NOTCH_W + 104
export const EXPANDED_W = 640;

/** Views still drawn on the wide 640 canvas: the greeting and the file drop. */
export const WIDE_VIEWS: ReadonlySet<IslandViewName> = new Set([
  "greeting", "upload", "uploading", "choose",
]);

export const ROUNDED_CORNER = 14; // hidden / compact
export const EXPANDED_CORNER = 22;

/** The small vertical bar the island rests as when idle, at the right edge.
 *  Hovering or clicking it opens the panel. Must match STRIP_W/STRIP_H in
 *  src-tauri/src/island.rs. */
export const WAKE_STRIP_W = 10;
export const WAKE_STRIP_H = 88;

export const VIEW_LAYOUTS: Record<IslandViewName, ViewLayout> = {
  // Portrait column: the character sits top-left beside the name (overview) or
  // vertically centred next to the text (the card views).
  overview: { height: 300, botX: 36, botY: 68, botDiameter: 36, agentMode: "column" },
  empty: { height: 170, botX: 36, botY: null, botDiameter: 38, agentMode: "none" },
  approval: { height: 180, botX: 36, botY: null, botDiameter: 36, agentMode: "column" },
  question: { height: 170, botX: 36, botY: null, botDiameter: 36, agentMode: "column" },
  error: { height: 170, botX: 36, botY: null, botDiameter: 36, agentMode: "column" },
  finished: { height: 200, botX: 36, botY: null, botDiameter: 36, agentMode: "column" },
  confused: { height: 160, botX: 44, botY: null, botDiameter: 40, agentMode: "column" },
  upload: { height: 176, botX: 140, botY: 104, botDiameter: 62, agentMode: "column" },
  // botY 103 = bar top (42 + 58) + 3, so the dot really rides the bar.
  uploading: { height: 176, botX: 46, botY: 103, botDiameter: 20, agentMode: "none" },
  choose: { height: 176, botX: 60, botY: 101, botDiameter: 52, agentMode: "column" },
  mail: { height: 200, botX: 36, botY: null, botDiameter: 36, agentMode: "column" },
  prompt: { height: 260, botX: 36, botY: null, botDiameter: 34, agentMode: "column" },
  searching: { height: 170, botX: 36, botY: null, botDiameter: 36, agentMode: "column" },
  result: { height: 200, botX: 36, botY: null, botDiameter: 36, agentMode: "column" },
  note: { height: 170, botX: 36, botY: null, botDiameter: 38, agentMode: "column" },
  settings: { height: 240, botX: 36, botY: 68, botDiameter: 36, agentMode: "none" },
  sessions: { height: 260, botX: 36, botY: 68, botDiameter: 36, agentMode: "column" },
  greeting: { height: 150, botX: 320, botY: 90, botDiameter: 0, agentMode: "none" },
};

// The upload views above are only the fallback geometry. Once a file is actually
// dropped the whole sequence — Mizuhara included — is drawn by src/upload, which
// owns its own constants (USC) straight from UploadSequenceEngine.swift.

/** Chat view grows with the conversation — IslandContainer.chatPromptHeight. */
export function chatPromptHeight(messageCount: number): number {
  return Math.min(360, 260 + messageCount * 40);
}

/** Overview height when there is nothing to list under the focused card. */
export const OVERVIEW_SOLO_H = 190;

export function islandSize(
  mode: IslandMode,
  view: IslandViewName,
  chatCount = 0,
): { w: number; h: number } {
  switch (mode) {
    case "hidden":
      // No notch to hide inside on a PC: the island retracts to zero height and
      // slides into the top edge of the screen instead of sitting there as a bar.
      return { w: NOTCH_W, h: 0 };
    case "compact":
      return { w: COMPACT_W, h: NOTCH_H };
    case "expanded": {
      // Portrait column for normal views; only the greeting and the file drop
      // keep the wide 640 canvas.
      const w = WIDE_VIEWS.has(view) ? EXPANDED_W : ISLAND_W;
      const h = view === "prompt" ? chatPromptHeight(chatCount) : VIEW_LAYOUTS[view].height;
      return { w, h };
    }
  }
}

export interface BotPlacement {
  cx: number;
  cy: number;
  diameter: number;
  opacity: number;
}

/** IslandRootView.botPosition — cy is measured from the island's top edge. */
export function botPosition(
  mode: IslandMode,
  view: IslandViewName,
  islandH: number,
  uploadProgress = 0,
): BotPlacement {
  switch (mode) {
    case "hidden":
      return { cx: 46, cy: 16, diameter: 6, opacity: 0 };
    case "compact":
      return { cx: 40, cy: 16, diameter: 20, opacity: 1 };
    case "expanded": {
      const layout = VIEW_LAYOUTS[view];
      if (view === "uploading") {
        return {
          cx: 36 + uploadProgress * 526,
          cy: layout.botY ?? 103,
          diameter: layout.botDiameter,
          opacity: 1,
        };
      }
      if (layout.botY != null) {
        return { cx: layout.botX, cy: layout.botY, diameter: layout.botDiameter, opacity: 1 };
      }
      // Centre of the fixed 84 pt card (8 pt top inset + 34 pt header → content at y = 42)
      const headerBottom = 42;
      const cardH = 84;
      const cy = headerBottom + (islandH - headerBottom - cardH) / 2 + cardH / 2;
      return { cx: layout.botX, cy, diameter: layout.botDiameter, opacity: 1 };
    }
  }
}

export function botGlowColor(s: BotStateName): string {
  switch (s) {
    case "working":
      return "#3B9EFF";
    case "thinking":
      return "#A78BFA";
    case "searching":
      return "#6366F1";
    case "approval":
      return "#F5A524";
    case "error":
      return "#F4505E";
    case "finished":
      return "#34D399";
    case "ratelimit":
      return "#F59E0B";
    default:
      return "#FFFFFF";
  }
}

export function botGlowOpacity(s: BotStateName): number {
  switch (s) {
    case "idle":
    case "sleeping":
      return 0.15;
    case "dizzy":
      return 0;
    default:
      return 0.65;
  }
}

// Project colours (IslandConst.projectColors)
const PROJECT_COLORS: Record<string, string> = {
  korus: "#FF5A4E",
  "sbe hub": "#2EC4A0",
  "morning ai brief": "#F29B38",
  "publication ig": "#7C5CFF",
  "ig post": "#7C5CFF",
  "louisraille.fr": "#38BDF8",
  louisraille: "#38BDF8",
  "notch buddy": "#EC4899",
  "notch-buddy": "#EC4899",
  notchbuddy: "#EC4899",
};

const FALLBACK_COLORS = ["#22C55E", "#EAB308", "#60A5FA", "#E879F9"];

export function colorForProject(name: string): string {
  const key = name.toLowerCase().trim();
  const exact = PROJECT_COLORS[key];
  if (exact) return exact;
  for (const [k, c] of Object.entries(PROJECT_COLORS)) {
    if (key.startsWith(k) || key.includes(k)) return c;
  }
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
}

// Card wash colours (CardBackground.washColor)
export type Wash = "red" | "green" | "pink" | "amber" | "cyan" | "indigo" | "soft" | null;

export function washRGBA(wash: Wash): string {
  switch (wash) {
    case "red":
      return "rgba(244,80,94,0.55)";
    case "green":
      return "rgba(52,211,153,0.5)";
    case "pink":
      return "rgba(244,114,182,0.55)";
    case "amber":
      return "rgba(245,165,36,0.42)";
    case "cyan":
      return "rgba(34,211,238,0.38)";
    case "indigo":
      return "rgba(99,102,241,0.5)";
    case "soft":
      return "rgba(255,255,255,0.08)";
    default:
      return "rgba(0,0,0,0)";
  }
}
