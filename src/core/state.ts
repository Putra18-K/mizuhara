// App state — mirror of AppState.swift (the parts the island needs).

import type { BotEmoteName, BotStateName, IslandMode, IslandViewName } from "./layout";
import type { EyeShape } from "../mizuhara/engine";

export type AgentSource = "claudeCode" | "n8n" | "agent";
export type PillBadge = "approval" | "finished" | "error";

export interface AgentTask {
  id: string;
  name: string;
  color: string;
  state: BotStateName;
  stepIndex: number;
  steps: string[];
  source: AgentSource;
  isIntegration: boolean;
  emote?: BotEmoteName | null;
  miniEye?: EyeShape | null;
  pillBadge?: PillBadge | null;
  sessionCwd?: string | null;
}

/** One live run of an agent. An agent pill can hold several at once. */
export interface AgentSession {
  id: string;
  /** Project name of the session. */
  label: string;
  cwd: string;
  state: BotStateName;
  steps: string[];
  stepIndex: number;
  badge: PillBadge | null;
  /** Final assistant message, read from the transcript on Stop. */
  result: string | null;
  updatedAt: number;
}

export interface ApprovalInfo {
  requestId: string;
  sessionId: string;
  /** Which pill this request belongs to — Claude Code or an approval-capable agent. */
  agentId: string;
  tool: string;
  command: string;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
}

export type PromptContext =
  | { kind: "window"; appName: string; title: string; url?: string }
  | { kind: "file"; name: string; path?: string };

export interface ResultItem {
  label: string;
  detail: string;
  url?: string;
}

export interface SearchResult {
  title: string;
  items: ResultItem[];
  note?: string;
}

const task = (
  id: string, name: string, color: string, source: AgentSource,
): AgentTask => ({
  id, name, color, state: "idle", stepIndex: 0, steps: [], source, isIntegration: true,
});

/** AgentTask.integrationAgents — same ids, names and colours as macOS. */
export const INTEGRATION_AGENTS: AgentTask[] = [
  task("integration_claude", "VS Code", "#F5F6F8", "claudeCode"),
  task("integration_resend", "Resend", "#22C55E", "n8n"),
  task("integration_n8n", "n8n", "#F29B38", "n8n"),
  task("integration_vercel", "Vercel", "#7C5CFF", "n8n"),
  task("integration_github", "GitHub", "#F4505E", "n8n"),
  task("integration_notion", "Notion", "#8C8C8C", "n8n"),
  task("integration_calcom", "Cal.com", "#C9956A", "n8n"),
  task("integration_stripe", "Stripe", "#0570DE", "n8n"),
];

export const TOGGLEABLE_INTEGRATION_IDS = [
  "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  "integration_notion", "integration_calcom", "integration_stripe",
];

/** What an integration poller last reported. */
export interface IntegrationInfo {
  data: Record<string, unknown>;
  error: string | null;
  loaded: boolean;
  configured: boolean;
}

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  absenceInterval: number;
  activeIntegrations: string[];
  screen: "primary" | "cursor";
  autostart: boolean;
  hooksInstalled: boolean;
  /** Command Code hooks installed into ~/.commandcode/settings.json. */
  commandcodeHooksInstalled: boolean;
  /** Claude model used by the chat. */
  model: string;
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 15,
  absenceInterval: 180,
  activeIntegrations: [
    "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  ],
  screen: "primary",
  autostart: false,
  hooksInstalled: false,
  commandcodeHooksInstalled: false,
  model: "claude-opus-5",
};

type Listener = () => void;

class AppState {
  mode: IslandMode = "hidden";
  view: IslandViewName = "overview";

  tasks: AgentTask[] = [];
  focusId: string | null = null;

  /** Live sessions per agent pill: one agent can run several at once. */
  sessions: Record<string, AgentSession[]> = {};
  private activeSession: Record<string, string> = {};

  stateOverride: BotStateName | null = null;

  /** Cursor in logical screen pixels, origin top-left (like AppState.mousePosition). */
  mouse = { x: 0, y: 0 };
  /** Cursor relative to the island's top-left corner. */
  mouseInIsland = { x: 0, y: 0 };

  isPinned = false;
  paused = false;

  uploadProgress = 0;
  uploadDuration = 2.4;
  fileDragOver = false;

  promptContext: PromptContext | null = null;
  droppedFile: { name: string; path: string } | null = null;
  noteMessage: string | null = null;
  searchResult: SearchResult | null = null;
  chatHistory: ChatMessage[] = [];
  pendingApproval: ApprovalInfo | null = null;

  integrations: Record<string, IntegrationInfo> = {};

  lastActivity = performance.now();

  settings: Settings = { ...DEFAULT_SETTINGS };

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Marks the UI dirty; the island re-renders on the next frame. */
  notify() {
    for (const fn of this.listeners) fn();
  }

  get focusTask(): AgentTask | null {
    return this.tasks.find((t) => t.id === this.focusId) ?? this.tasks[0] ?? null;
  }

  get effectiveState(): BotStateName {
    return this.stateOverride ?? this.focusTask?.state ?? "idle";
  }

  get otherTasks(): AgentTask[] {
    return this.tasks.filter((t) => t.id !== this.focusId);
  }

  /** The session behind the focused pill (its steps, result and state). */
  get focusSession(): AgentSession | null {
    const t = this.focusTask;
    if (!t) return null;
    const list = this.sessions[t.id];
    if (!list || list.length === 0) return null;
    const sid = this.activeSessionId(t.id);
    return list.find((x) => x.id === sid) ?? list[0];
  }

  setFocus(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    this.focusId = id;
    t.pillBadge = null;
    for (const s of this.sessions[id] ?? []) s.badge = null;
    this.notify();
  }

  updateTask(id: string, state: BotStateName) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.state = state;
    this.notify();
  }

  appendStep(id: string, step: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.steps.push(step);
    if (t.steps.length > 20) t.steps.shift();
    t.stepIndex = t.steps.length - 1;
    this.notify();
  }

  setPillBadge(id: string, badge: PillBadge | null) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.pillBadge = badge;
    this.notify();
  }

  // ── Sessions ───────────────────────────────────────────────────────────────
  // An agent pill ("Command Code", "VS Code", any --agent tag) can have several
  // sessions running at once. The *active* one is mirrored onto the pill, so the
  // ticker, the bot colour and the badge keep working with no view changes.

  sessionList(agentId: string): AgentSession[] {
    return this.sessions[agentId] ?? [];
  }

  activeSessionId(agentId: string): string | null {
    const list = this.sessions[agentId];
    if (!list || list.length === 0) return null;
    return this.activeSession[agentId] ?? list[0].id;
  }

  /** Creates or refreshes a session; the agent pill must already exist. */
  touchSession(
    agentId: string, sessionId: string, label: string, cwd: string,
  ): AgentSession | null {
    if (!this.tasks.some((t) => t.id === agentId)) return null;
    const sid = sessionId || "default";
    const list = this.sessions[agentId] ?? (this.sessions[agentId] = []);
    let s = list.find((x) => x.id === sid);
    if (!s) {
      s = {
        id: sid, label: label || "Session", cwd, state: "idle",
        steps: [], stepIndex: 0, badge: null, result: null,
        updatedAt: performance.now(),
      };
      list.push(s);
    }
    if (label) s.label = label;
    if (cwd) s.cwd = cwd;
    s.updatedAt = performance.now();
    if (!this.activeSession[agentId]) this.activeSession[agentId] = sid;
    this.mirrorSessions(agentId);
    this.notify();
    return s;
  }

  setActiveSession(agentId: string, sessionId: string) {
    this.activeSession[agentId] = sessionId;
    this.mirrorSessions(agentId);
    this.notify();
  }

  setSessionState(agentId: string, sessionId: string, state: BotStateName) {
    this.withSession(agentId, sessionId, (s) => { s.state = state; });
  }

  appendSessionStep(agentId: string, sessionId: string, step: string) {
    this.withSession(agentId, sessionId, (s) => {
      s.steps.push(step);
      if (s.steps.length > 20) s.steps.shift();
      s.stepIndex = s.steps.length - 1;
    });
  }

  setSessionBadge(agentId: string, sessionId: string, badge: PillBadge | null) {
    this.withSession(agentId, sessionId, (s) => { s.badge = badge; });
  }

  /** The final assistant message of a run, shown on the "finished" card. */
  setSessionResult(agentId: string, sessionId: string, result: string | null) {
    this.withSession(agentId, sessionId, (s) => { s.result = result; });
  }

  /** Drops one session; removes the pill once its last session is gone. */
  removeSession(agentId: string, sessionId: string) {
    const list = this.sessions[agentId];
    if (!list) return;
    const sid = sessionId || "default";
    const idx = list.findIndex((x) => x.id === sid);
    if (idx < 0) return;
    list.splice(idx, 1);
    if (this.activeSession[agentId] === sid) this.activeSession[agentId] = list[0]?.id ?? "";
    if (list.length === 0) {
      delete this.sessions[agentId];
      delete this.activeSession[agentId];
      this.removeTask(agentId);
      return;
    }
    this.mirrorSessions(agentId);
    this.notify();
  }

  /** Resets one session's steps without dropping it (Claude Code SessionEnd). */
  clearSession(agentId: string, sessionId: string) {
    this.withSession(agentId, sessionId, (s) => {
      s.steps = [];
      s.stepIndex = 0;
      s.state = "idle";
      s.badge = null;
    });
  }

  private withSession(agentId: string, sessionId: string, fn: (s: AgentSession) => void) {
    const list = this.sessions[agentId];
    if (!list) return;
    const s = list.find((x) => x.id === (sessionId || "default"));
    if (!s) return;
    fn(s);
    s.updatedAt = performance.now();
    this.mirrorSessions(agentId);
    this.notify();
  }

  /** Copies the active session onto the pill so existing views need no change. */
  private mirrorSessions(agentId: string) {
    const t = this.tasks.find((x) => x.id === agentId);
    const list = this.sessions[agentId];
    if (!t || !list || list.length === 0) return;
    const sid = this.activeSession[agentId] ?? list[0].id;
    const s = list.find((x) => x.id === sid) ?? list[0];
    t.state = s.state;
    t.steps = s.steps;
    t.stepIndex = s.stepIndex;
    if (s.cwd) t.sessionCwd = s.cwd;
    t.pillBadge = list.find((x) => x.badge)?.badge ?? null;
  }

  /** loadIntegrationTasks() — VS Code always on, the rest opt-in (max 4). */
  loadIntegrationTasks() {
    for (const proto of INTEGRATION_AGENTS) {
      const shouldLoad =
        proto.id === "integration_claude" || this.settings.activeIntegrations.includes(proto.id);
      const idx = this.tasks.findIndex((t) => t.id === proto.id);
      if (shouldLoad && idx < 0) this.tasks.push({ ...proto, steps: [] });
      if (!shouldLoad && idx >= 0) this.tasks.splice(idx, 1);
    }
    // Order: integration_claude first, then agent_* pills (visible in slice(0,4)),
    // then other integrations in declaration order.
    const order = INTEGRATION_AGENTS.map((t) => t.id);
    this.tasks.sort((a, b) => {
      const isAgentA = a.id.startsWith("agent_");
      const isAgentB = b.id.startsWith("agent_");
      // integration_claude always first
      if (a.id === "integration_claude") return -1;
      if (b.id === "integration_claude") return 1;
      // agent_* before other integrations; preserve insertion order among themselves
      if (isAgentA && !isAgentB) return -1;
      if (isAgentB && !isAgentA) return 1;
      if (isAgentA && isAgentB) return 0;
      // both known integrations → declaration order
      return order.indexOf(a.id) - order.indexOf(b.id);
    });
    if (!this.focusId) this.focusId = "integration_claude";
    this.notify();
  }

  removeTask(id: string) {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx < 0) return;
    this.tasks.splice(idx, 1);
    delete this.sessions[id];
    delete this.activeSession[id];
    if (this.focusId === id) this.focusId = this.tasks[0]?.id ?? "integration_claude";
    this.notify();
  }

  /** Creates a dynamic agent_ pill on first event; no-ops if it already exists.
   *  Inserted right after integration_claude so it appears in the visible slice(0,4). */
  upsertExternalAgent(id: string, name: string, color: string) {
    if (this.tasks.some((t) => t.id === id)) return;
    const at = this.tasks.findIndex((t) => t.id === "integration_claude") + 1;
    this.tasks.splice(at, 0, {
      id, name, color,
      state: "idle", stepIndex: 0, steps: [],
      source: "agent", isIntegration: false,
    });
    if (!this.focusId) this.focusId = id;
    this.notify();
  }

  toggleIntegration(id: string) {
    if (id === "integration_claude") return;
    const active = this.settings.activeIntegrations;
    if (active.includes(id)) {
      this.settings.activeIntegrations = active.filter((x) => x !== id);
      if (this.focusId === id) this.focusId = "integration_claude";
    } else {
      if (active.length >= 4) return;
      this.settings.activeIntegrations = [...active, id];
    }
    this.loadIntegrationTasks();
  }

  defaultView(): IslandViewName {
    return this.tasks.length === 0 ? "empty" : "overview";
  }
}

export const State = new AppState();
