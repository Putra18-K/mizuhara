// Claude Code hook events → island state.
// Port of HookServer.processEvent / processPermissionRequest from the macOS app.
// Difference from macOS: no terminal filter. On Windows the hook fires from any
// terminal (Windows Terminal, VS Code, PowerShell…) and all of them are handled.

import { Bridge, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { Island } from "./island";

const CLAUDE_ID = "integration_claude";

/** Agents the island names itself, so a pill reads "Command Code", not the raw tag. */
const KNOWN_AGENTS: Record<string, { name: string; color: string }> = {
  commandcode: { name: "Command Code", color: "#D97757" },
};

/** Agents allowed to raise an Allow/Deny card, not just show live progress. */
const APPROVAL_AGENTS = new Set(["commandcode"]);

/** Clears the approval card if no decision was made before the hook gave up. */
let pendingTimeout: number | null = null;

interface HookPayload {
  hook_event_name?: string;
  request_id?: string;
  session_id?: string;
  cwd?: string;
  message?: string;
  /** Final assistant message, attached by the relay on Stop (from the transcript). */
  result?: string;
  /** UserPromptSubmit carries `prompt`; `message` belongs to Notification/Stop. */
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** Optional agent tag: lowercase, digits and hyphens, ≤ 24 chars. */
  mizuhara_agent?: string;
}

/** Same rule as HookServer.validateAgent on macOS. "claude" is reserved. */
function validateAgent(raw: string | undefined): string | null {
  if (!raw || raw.length > 24 || raw === "claude") return null;
  if (!/^[a-z0-9-]+$/.test(raw)) return null;
  return raw;
}

const FALLBACK_COLORS = ["#22C55E", "#EAB308", "#60A5FA", "#E879F9"];

function agentColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  }
  return FALLBACK_COLORS[Math.abs(h) % FALLBACK_COLORS.length];
}

const PROJECT_ALIASES: Record<string, string> = {
  "notch-buddy": "Notch Buddy",
  notchbuddy: "Notch Buddy",
  notch_buddy: "Notch Buddy",
};

function aliasProjectName(name: string): string {
  return PROJECT_ALIASES[name.toLowerCase()] ?? name;
}

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** frenchStep() — same labels as the macOS app. */
const TOOL_LABELS: Record<string, string> = {
  Bash: "Exécute",
  Read: "Lit",
  Write: "Écrit",
  Edit: "Modifie",
  Glob: "Cherche",
  Grep: "Recherche",
  WebSearch: "Recherche web",
  WebFetch: "Récupère",
  TodoWrite: "Tâches",
  Task: "Agent",
  LS: "Liste",
  MultiEdit: "Modifie",
  NotebookEdit: "Notebook",
  PowerShell: "Exécute",
};

function stepLabel(tool: string, input: Record<string, unknown>): string {
  const label = TOOL_LABELS[tool] ?? tool;
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  const cmd = str("command");
  if (cmd) return `${label} · ${cmd.slice(0, 40)}`;
  const path = str("path");
  if (path) return `${label} · ${lastPathComponent(path)}`;
  const file = str("file_path");
  if (file) return `${label} · ${lastPathComponent(file)}`;
  const query = str("query");
  if (query) return `${label} · ${query.slice(0, 40)}`;
  return label;
}

/**
 * What the Allow button actually authorises. Approving "Write" tells you nothing
 * — approving `Write · C:\…\.env` tells you everything, and the difference is
 * the whole point of approving from the island rather than blind.
 *
 * Ordered by how specific the field is, so an unfamiliar tool still shows
 * whatever identifying string it carries instead of falling back to its name.
 */
const APPROVAL_FIELDS = [
  "command", // Bash, PowerShell
  "file_path", // Write, Edit, MultiEdit, NotebookEdit
  "path", // Read, LS
  "url", // WebFetch
  "query", // WebSearch
  "pattern", // Glob, Grep
  "prompt", // Task
] as const;

function approvalTarget(tool: string, input: Record<string, unknown>): string {
  for (const field of APPROVAL_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      return `${tool} · ${value.trim()}`;
    }
  }
  return tool;
}

function upsert(projectName: string, cwd: string) {
  const t = State.tasks.find((x) => x.id === CLAUDE_ID);
  if (!t) return;
  t.name = projectName;
  if (cwd) t.sessionCwd = cwd;
}

export function registerHookHandlers(island: Island) {
  void onEvent<HookPayload>("hook", (payload) => handleHook(island, payload));
}

function handleHook(island: Island, payload: HookPayload) {
  if (State.paused) {
    // Silence here used to cost Claude Code nearly two minutes: the relay waited
    // for a decision from an island that had already decided not to look. Say so,
    // and the terminal takes the question immediately.
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }

  const name = payload.hook_event_name ?? "";
  const cwd = payload.cwd ?? "";
  const sid = payload.session_id ?? "";
  const raw = lastPathComponent(cwd);
  const projectName = aliasProjectName(raw || "Session");

  // Route to the right pill. Valid mizuhara_agent → dynamic "agent_<name>" pill.
  // "claude" is reserved; absent or invalid → Claude Code pill unchanged.
  const validAgent = validateAgent(payload.mizuhara_agent);
  const agentId = validAgent ? `agent_${validAgent}` : CLAUDE_ID;
  const isExternalAgent = validAgent !== null;

  /** How this agent is named in notifications and the finished card. */
  const agentLabel = isExternalAgent
    ? (KNOWN_AGENTS[validAgent!]?.name ?? validAgent!)
    : "Claude Code";

  /** Alerts open the island; work events only update the pills — it opens on hover. */
  const surface = (view: Parameters<Island["alert"]>[0], isAlert: boolean) => {
    if (!isAlert) return;
    if (State.mode === "expanded") island.setView(view);
    else island.alert(view);
  };

  /** Ensure the agent pill exists (no-op for Claude Code) and its session. */
  const ensurePill = () => {
    if (isExternalAgent) {
      const known = KNOWN_AGENTS[validAgent!];
      State.upsertExternalAgent(
        agentId,
        known?.name ?? validAgent!,
        known?.color ?? agentColor(validAgent!),
      );
    } else {
      upsert(projectName, cwd);
    }
    // One agent can run several sessions at once; the active one drives the pill.
    State.touchSession(agentId, sid, projectName, cwd);
  };

  // Every event belongs to a session. Create the pill/session up front, wherever
  // the event arrives (a session can be running before we ever see SessionStart).
  ensurePill();

  switch (name) {
    case "SessionStart":
      ensurePill();
      surface("overview", false);
      Sound.play("work");
      break;

    case "UserPromptSubmit": {
      ensurePill();
      State.setSessionState(agentId, sid, "thinking");
      // The field is `prompt`; reading `message` meant this step was always blank.
      const asked = payload.prompt ?? payload.message;
      if (asked) State.appendSessionStep(agentId, sid, asked.slice(0, 60));
      surface("overview", false);
      break;
    }

    case "PreToolUse": {
      ensurePill();
      State.setSessionState(agentId, sid, "working");
      const tool = payload.tool_name ?? "Tool";
      State.appendSessionStep(agentId, sid, stepLabel(tool, payload.tool_input ?? {}));
      surface("overview", false);
      break;
    }

    case "PostToolUse":
      State.setSessionState(agentId, sid, "working");
      break;

    case "PostToolUseFailure":
      State.setSessionState(agentId, sid, "working");
      State.appendSessionStep(agentId, sid, "⚠ failed");
      break;

    case "Notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        State.setSessionState(agentId, sid, "ratelimit");
        Sound.play("rate");
      } else if (message.endsWith("?")) {
        State.setSessionState(agentId, sid, "question");
        State.appendSessionStep(agentId, sid, message);
      }
      break;
    }

    case "Stop": {
      State.setSessionState(agentId, sid, "finished");
      // The final assistant message, read from the transcript by the relay.
      State.setSessionResult(agentId, sid, payload.result ?? null);
      if (payload.message) State.appendSessionStep(agentId, sid, payload.message.slice(0, 60));
      Sound.play("finish");
      // The "an agent finished" notification: bring that session forward, open the
      // finished card with its result, and raise a system notification too so it is
      // seen even when the island is tucked away.
      State.setActiveSession(agentId, sid);
      State.setFocus(agentId);
      surface("finished", true);
      const done = (payload.result ?? payload.message ?? `Finished in ${projectName}`).trim();
      void Bridge.notify(`${agentLabel} · selesai`, done.length > 180 ? `${done.slice(0, 180)}…` : done);
      // Keep the result around long enough to be read, then clear the pill.
      window.setTimeout(() => {
        if (isExternalAgent) {
          State.removeSession(agentId, sid);
        } else {
          State.setSessionState(agentId, sid, "idle");
          State.setSessionBadge(agentId, sid, null);
        }
      }, 90_000);
      break;
    }

    case "StopFailure": {
      State.setSessionState(agentId, sid, "error");
      State.setSessionResult(agentId, sid, payload.result ?? null);
      Sound.play("error");
      State.setActiveSession(agentId, sid);
      State.setFocus(agentId);
      surface("error", true);
      const why = (payload.result ?? payload.message ?? "Stopped on an error").trim();
      void Bridge.notify(`${agentLabel} · error`, why.length > 180 ? `${why.slice(0, 180)}…` : why);
      break;
    }

    case "SessionEnd":
      if (isExternalAgent) {
        State.removeSession(agentId, sid);
      } else {
        State.setSessionState(agentId, sid, "idle");
        State.clearSession(agentId, sid);
      }
      break;

    case "SubagentStart":
      State.appendSessionStep(agentId, sid, "+ subagent");
      break;

    case "SubagentStop":
      State.appendSessionStep(agentId, sid, "• subagent done");
      break;

    case "PermissionRequest": {
      // Claude Code always gets a card. Command Code does when its hook turned a
      // PreToolUse into an approval. Any other agent is declined so it re-asks in
      // its own terminal instead of wearing a card that isn't its own.
      const canApprove =
        !isExternalAgent || (validAgent !== null && APPROVAL_AGENTS.has(validAgent));
      if (!canApprove) {
        if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
        break;
      }

      const requestId = payload.request_id ?? "";
      // One card, one request. A second one must never quietly replace the first
      // — that would leave a human staring at request B while request A waits for
      // a decision nobody can give. Hand it straight back to the terminal.
      if (State.pendingApproval && State.pendingApproval.requestId !== requestId) {
        if (requestId) void Bridge.approvalDecline(requestId);
        break;
      }
      ensurePill();
      if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
      const tool = payload.tool_name ?? "Tool";
      const input = payload.tool_input ?? {};
      State.pendingApproval = {
        requestId,
        sessionId: payload.session_id ?? "",
        agentId,
        tool,
        command: approvalTarget(tool, input),
      };
      // Bring the card to the agent that raised it, whichever pill was focused.
      State.setFocus(agentId);
      // The relay's short ack window closes in 800 ms; everything below this
      // line is synchronous, so the card really is up by the time it lands.
      if (requestId) void Bridge.approvalAck(requestId);
      State.setSessionState(agentId, sid, "approval");
      State.isPinned = true;
      Sound.play("approval");
      island.alert("approval");
      // Mizuhara answers within 108 s or not at all; after that the terminal has
      // taken over and the card would be lying.
      pendingTimeout = window.setTimeout(() => {
        pendingTimeout = null;
        if (!State.pendingApproval) return;
        State.pendingApproval = null;
        State.isPinned = false;
        island.dropPin();
        State.setSessionState(agentId, sid, "working");
        State.setSessionBadge(agentId, sid, null);
        if (State.view === "approval") island.setView(State.defaultView());
        State.notify();
      }, 110_000);
      break;
    }

    default:
      break;
  }
  State.notify();
}
