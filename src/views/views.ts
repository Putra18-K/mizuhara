// Island views — DOM ports of IslandViewContent.swift. Paddings, font sizes,
// colours and wording are copied from the Swift views so both platforms read
// identically.

import { h, svg, clear, dot, type Child } from "./dom";
import { ICONS } from "./icons";
import { Ticker } from "./ticker";
import { State, type AgentTask } from "../core/state";
import { washRGBA, type IslandViewName, type Wash } from "../core/layout";
import { createMiniBot, pruneMiniBots } from "../mizuhara/minibots";
import { buildPrompt } from "./chat";
import { buildChoose, buildUpload, buildUploading } from "./upload";
import { renderIntegrationCard, type IntegrationCardHooks } from "./integrations";

export interface ViewActions {
  setView(v: IslandViewName): void;
  collapse(): void;
  setFocus(id: string): void;
  openTerminal(): void;
  /** The ↗ button: opens whatever the focused pill points at. */
  openTarget(): void;
  openUrl(url: string): void;
  decide(d: "allow" | "deny"): void;
  toggleSound(): void;
  setVolume(v: number): void;
  setAutoClose(seconds: number): void;
  openSettingsWindow(): void;
  blip(): void;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /** Called every frame while the view is on screen. */
  tick?(nowMs: number): void;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

function btn(
  label: string,
  kind: "primary" | "secondary",
  onClick: () => void,
  kbd?: string,
): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

/** The grey label next to an agent's name — same wording as the macOS OverviewView. */
function sourceLabel(task: AgentTask | null): string {
  switch (task?.source) {
    case "claudeCode":
      return "Claude Code";
    case "agent":
      return "Agent";
    default:
      return "n8n";
  }
}

/** AgentWho — coloured dot + task name + grey label. */
function agentWho(task: AgentTask | null, label: string): HTMLElement {
  const row = h("div", { class: "who-row" });
  if (task) {
    row.append(dot(task.color, 8), h("span", { class: "n", text: task.name }));
  }
  row.append(h("span", { text: label }));
  return row;
}

function stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return el;
}

/** Left padding shared by every portrait card, clearing the character sprite. */
const CARD_PAD = 68;

// ── Header ────────────────────────────────────────────────────────────────────

export function buildHeader(actions: ViewActions): ViewHost {
  const tabHome = h("button", { class: "tab", title: "Overview", onclick: () => go("overview") }, svg(ICONS.house, 13));
  const tabChat = h("button", { class: "tab", title: "Ask", onclick: () => go("prompt") }, svg(ICONS.bubble, 13));
  const tabDrop = h("button", { class: "tab", title: "Drop", onclick: () => go("upload") }, svg(ICONS.plus, 13));

  const gearBtn = h("button", { title: "Settings", onclick: () => go("settings") }, svg(ICONS.gear, 14));
  const soundBtn = h("button", { title: "Mute", onclick: () => actions.toggleSound() }, svg(ICONS.speakerOn, 14));

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  const el = h(
    "div",
    { id: "header" },
    h("div", { class: "tabs" }, tabHome, tabChat, tabDrop),
    h("div", { class: "header-actions" }, gearBtn, soundBtn),
  );

  return {
    el,
    sync() {
      const v = State.view;
      tabHome.classList.toggle("on", v === "overview" || v === "empty");
      tabChat.classList.toggle("on", v === "prompt");
      tabDrop.classList.toggle("on", v === "upload");
      gearBtn.classList.toggle("on", v === "settings");
      clear(gearBtn);
      gearBtn.append(svg(v === "settings" ? ICONS.gearFill : ICONS.gear, 14));
      clear(soundBtn);
      soundBtn.append(svg(State.settings.soundEnabled ? ICONS.speakerOn : ICONS.speakerOff, 14));
      el.style.opacity = v === "confused" ? "0" : "1";
    },
  };
}

// ── Overview ──────────────────────────────────────────────────────────────────

function buildOverview(actions: ViewActions): ViewHost {
  const ticker = new Ticker();
  const who = h("div", { class: "who" });
  const tickerBody = h("div", { class: "card-body" }, who, ticker.el);
  const leftBody = h("div", { class: "left-body" });
  const jump = h(
    "button",
    { class: "icon-btn jump", title: "Open", onclick: () => actions.openTarget() },
    svg(ICONS.arrowUpRight, 8),
  );
  const left = card(null, leftBody, jump);
  const pills = h("div", { class: "pills" });
  const right = card(null, pills);

  const el = h("div", { class: "view overview" },
    h("div", { class: "left" }, left),
    h("div", { class: "right" }, right),
  );

  let pillIds = "";
  let detailOpen = false;
  let lastFocus: string | null = null;
  let mode: "ticker" | "card" | null = null;
  let cardKey = "";

  const hooks: IntegrationCardHooks = {
    get detailOpen() {
      return detailOpen;
    },
    openDetail() {
      detailOpen = true;
      cardKey = "";
      State.notify();
    },
    closeDetail() {
      detailOpen = false;
      cardKey = "";
      State.notify();
    },
    openSettings: () => actions.openSettingsWindow(),
  };

  return {
    el,
    tick(nowMs: number) {
      if (mode === "ticker") ticker.tick(nowMs);
    },
    sync() {
      const task = State.focusTask;
      if (task?.id !== lastFocus) {
        lastFocus = task?.id ?? null;
        detailOpen = false;
        cardKey = "";
        mode = null;
      }

      // Mirrors OverviewView on macOS: integration pills render their card, while
      // agent sessions render the live ticker. External agents (`agent_*` pills)
      // are not integrations, so they always get the ticker; Claude Code is
      // modelled as an integration here, so it is the one integration that
      // switches to the ticker once it has something to show.
      const isAgentSession = task != null && !task.isIntegration;
      const claudeSession =
        task?.id === "integration_claude" && (task.state !== "idle" || task.steps.length > 0);

      if (task && (isAgentSession || claudeSession)) {
        if (mode !== "ticker") {
          clear(leftBody);
          leftBody.append(tickerBody);
          mode = "ticker";
          cardKey = "";
        }
        clear(who);
        who.append(
          dot(task.color, 7),
          h("span", { class: "name", text: task.name }),
          h("span", { class: "tool", text: sourceLabel(task) }),
        );
        if (task.steps.length > 1) {
          who.append(h("span", {
            class: "count",
            text: `${Math.min(task.stepIndex + 1, task.steps.length)}/${task.steps.length}`,
          }));
        }
        ticker.sync(task);
      } else if (task) {
        const info = State.integrations[task.id];
        const key = [
          task.id, detailOpen, task.state, task.steps.join("|"),
          info?.loaded, info?.error, info?.configured,
          JSON.stringify(info?.data ?? {}),
        ].join("~");
        if (key !== cardKey) {
          cardKey = key;
          mode = "card";
          clear(leftBody);
          leftBody.append(renderIntegrationCard(task, hooks));
        }
      }

      jump.style.display = detailOpen ? "none" : "";

      const others = State.otherTasks.slice(0, 4);
      // Nothing to list: hide the second card so it does not leave an empty block.
      const hasOthers = others.length > 0;
      right.style.display = hasOthers ? "" : "none";
      left.style.flex = hasOthers ? "0 0 126px" : "1 1 auto";
      left.style.height = hasOthers ? "126px" : "auto";
      const pillKey = others
        .map((t) => `${t.id}:${t.pillBadge ?? ""}:${State.sessionList(t.id).length}`)
        .join("|");
      if (pillKey !== pillIds) {
        pillIds = pillKey;
        clear(pills);
        for (const t of others) pills.append(buildPill(t, actions));
        pruneMiniBots();
      }
    },
  };
}

function buildPill(task: AgentTask, actions: ViewActions): HTMLElement {
  const label = task.id === "integration_claude" ? "VS Code" : task.name;
  const canvas = createMiniBot(task, 24);
  const sessions = State.sessionList(task.id).length;
  const pill = h(
    "div",
    {
      class: "pill",
      onclick: () => {
        actions.setFocus(task.id);
        // Several runs at once: open the list so every session is reachable.
        if (sessions > 1) actions.setView("sessions");
      },
    },
    canvas,
    h("span", { class: "lbl", text: label }),
  );
  if (sessions > 1) pill.append(h("span", { class: "pill-count", text: String(sessions) }));
  pill.style.borderColor = `${task.color}24`;
  pill.addEventListener("mouseenter", () => {
    pill.style.background = `${task.color}2e`;
    pill.style.borderColor = `${task.color}8c`;
    pill.style.boxShadow = `0 2px 10px ${task.color}59`;
    (pill.querySelector(".lbl") as HTMLElement).style.color = lighten(task.color, 0.3);
  });
  pill.addEventListener("mouseleave", () => {
    pill.style.background = "";
    pill.style.borderColor = `${task.color}24`;
    pill.style.boxShadow = "";
    (pill.querySelector(".lbl") as HTMLElement).style.color = "";
  });

  if (task.pillBadge) {
    const colors = { approval: "#F5A524", finished: "#22C55E", error: "#F4505E" } as const;
    const icons = { approval: ICONS.bang, finished: ICONS.check, error: ICONS.xmark } as const;
    const inner = h("i", { style: `background:${colors[task.pillBadge]}` }, svg(icons[task.pillBadge], 6, { stroke: task.pillBadge === "finished" ? 3 : 0 }));
    const badge = h("div", { class: "pill-badge" }, inner);
    badge.style.boxShadow = `0 0 4px ${colors[task.pillBadge]}99`;
    pill.append(badge);
  }
  return pill;
}

function lighten(hex: string, amount: number): string {
  const v = parseInt(hex.replace("#", ""), 16);
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) =>
    Math.min(255, Math.round(x + amount * 255)),
  );
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ── Empty ─────────────────────────────────────────────────────────────────────

function buildEmpty(actions: ViewActions): ViewHost {
  // A column, not a row: the portrait card is only 288 wide, so a title, a
  // sentence and a button side by side left the text a ~90px sliver that wrapped
  // to five lines and spilled out of the card.
  const body = h(
    "div",
    { class: "stack", style: `padding:0 18px 0 ${CARD_PAD}px;align-items:flex-start;gap:10px` },
    h("div", { class: "title", text: "Nothing running right now." }),
    h("div", { class: "sub", text: "Drop a file or window, or ask me anything." }),
    btn("Ask Claude", "primary", () => actions.setView("prompt")),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Approval ──────────────────────────────────────────────────────────────────

function buildApproval(actions: ViewActions): ViewHost {
  const who = h("div");
  const code = h("div", { class: "code" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("amber", stack(CARD_PAD, 16, who, code, row)));
  let rowKey = "";
  return {
    el,
    sync() {
      clear(who);
      // The card belongs to the agent that raised it, which is not necessarily
      // the focused pill (an approval yanks focus here, but be explicit).
      const owner =
        State.tasks.find((t) => t.id === State.pendingApproval?.agentId) ?? State.focusTask;
      who.append(agentWho(owner, "needs permission"));
      // The whole point of approving here rather than in the terminal: this line
      // is the command, the file path or the URL being authorised, not just the
      // name of the tool asking.
      code.textContent = State.pendingApproval?.command || State.pendingApproval?.tool || "…";
      // Two buttons, built once. Rebuilding them between a mouse-down and a
      // mouse-up would swallow the click, and there is nothing left to vary:
      // "Always" is gone until the remembered-rules list exists to back it.
      if (rowKey === "built") return;
      rowKey = "built";
      clear(row);
      row.append(
        btn("Deny", "secondary", () => actions.decide("deny"), "N"),
        btn("Allow", "primary", () => actions.decide("allow"), "Y"),
      );
    },
  };
}

// ── Question ──────────────────────────────────────────────────────────────────

function buildQuestion(): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title clamp-3" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("cyan", stack(CARD_PAD, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, "Claude Code is asking a question"));
      const task = State.focusTask;
      title.textContent = task?.steps.at(-1) ?? "Claude needs an answer.";
      clear(row);
      row.append(h("div", { class: "sub", text: "Answer in your terminal — Mizuhara can't reply for you yet." }));
    },
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

function buildError(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title", text: "Workflow stopped." });
  const detail = h("div", { class: "detail clamp-2" });
  const row = h("div", { class: "actions" },
    btn("Retry", "primary", () => actions.setView(State.defaultView())),
    btn("Open in n8n", "secondary", () => actions.openTarget()),
  );
  const el = h("div", { class: "view" }, card("red", stack(CARD_PAD, 16, who, title, detail, row)));
  return {
    el,
    sync() {
      const task = State.focusTask;
      clear(who);
      who.append(agentWho(task, sourceLabel(task)));
      title.textContent = task?.source === "n8n" ? "Workflow stopped." : "Session stopped on an error.";
      detail.textContent = task?.steps.at(-1) ?? "No detail available.";
    },
  };
}

// ── Finished ──────────────────────────────────────────────────────────────────

function buildFinished(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title clamp-4" });
  const row = h("div", { class: "actions" },
    btn("Open terminal", "primary", () => actions.openTerminal()),
    btn("OK", "secondary", () => actions.collapse()),
  );
  const el = h("div", { class: "view" }, card("green", stack(CARD_PAD, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      const session = State.focusSession;
      who.append(agentWho(State.focusTask, `${sourceLabel(State.focusTask)} finished`));
      // The final assistant message when the relay managed to read it, else the
      // last step we saw. Trimmed so a long answer still fits the card.
      const text = session?.result ?? session?.steps.at(-1) ?? "Session finished";
      title.textContent = text.length > 240 ? `${text.slice(0, 240)}…` : text;
    },
  };
}

// ── Confused ──────────────────────────────────────────────────────────────────

function buildConfused(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: `padding:0 18px 0 ${CARD_PAD}px` },
    h("div", { class: "title", text: "Too many hits at once." }),
    h("div", { class: "sub", text: "Give me a sec — back to work in three seconds." }),
  );
  return { el: h("div", { class: "view" }, card("pink", body)), sync() {} };
}

// ── Note ──────────────────────────────────────────────────────────────────────

function buildNote(): ViewHost {
  const title = h("div", { class: "title clamp-3" });
  const el = h("div", { class: "view" }, card(null, h("div", { class: "stack", style: `padding:0 18px 0 ${CARD_PAD}px` }, title)));
  return {
    el,
    sync() {
      title.textContent = State.noteMessage ?? "";
    },
  };
}

// ── In-island settings ────────────────────────────────────────────────────────

function buildSettings(actions: ViewActions): ViewHost {
  const row = (...children: Child[]) => h("div", { class: "settings-row" }, ...children);
  const grow = () => h("div", { class: "grow" });

  const soundSwitch = h("button", { class: "switch", onclick: () => actions.toggleSound() });
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    oninput: (e: Event) => actions.setVolume(Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;

  const segButtons = [10, 15, 30].map((s) =>
    h("button", { onclick: () => actions.setAutoClose(s) }, `${s}s`),
  );
  const claudeBadge = h("span", { class: "status-badge" });
  const ccBadge = h("span", { class: "status-badge" });
  const apiBadge = h("span", { class: "status-badge" });

  // One control per row, each pushed against its label — a fixed 288-wide column
  // leaves no room for the old inline label + control + badges + link, which is
  // what made "Auto-close" wrap and the "Settings…" link fall off the card.
  const rows = h(
    "div",
    { class: "settings-rows" },
    row(soundSwitch, h("span", { class: "lab", text: "Sound" }), grow(), volume),
    row(h("span", { class: "lab", text: "Auto-close" }), grow(), h("div", { class: "seg" }, ...segButtons)),
    row(claudeBadge, ccBadge, apiBadge),
    row(grow(), h("button", {
      class: "link-btn",
      style: "color:#8e939c",
      text: "Settings…",
      onclick: () => actions.openSettingsWindow(),
    })),
  );

  const el = h("div", { class: "view" },
    card(null, h("div", { class: "stack", style: `padding:14px 16px 14px ${CARD_PAD}px` }, rows)));

  return {
    el,
    sync() {
      const s = State.settings;
      soundSwitch.classList.toggle("on", s.soundEnabled);
      volume.value = String(s.soundVolume);
      volume.style.opacity = s.soundEnabled ? "1" : "0.4";
      segButtons.forEach((b, i) => b.classList.toggle("on", s.autoCloseInterval === [10, 15, 30][i]));
      clear(claudeBadge);
      claudeBadge.append(
        dot(s.hooksInstalled ? "#22C55E" : "#F4505E", 6),
        h("span", { text: "Claude Code" }),
      );
      clear(ccBadge);
      ccBadge.append(
        dot(s.commandcodeHooksInstalled ? "#22C55E" : "#F4505E", 6),
        h("span", { text: "Command" }),
      );
      clear(apiBadge);
      apiBadge.append(dot(State.apiKeyPresent ? "#22C55E" : "#F4505E", 6), h("span", { text: "API" }));
    },
  };
}

// ── Sessions ──────────────────────────────────────────────────────────────────

/** An agent can run several sessions at once; this lists them all. */
function buildSessions(actions: ViewActions): ViewHost {
  const who = h("div", { class: "who" });
  const list = h("div", { class: "session-list" });
  const el = h("div", { class: "view" }, card(null, h("div", { class: "card-body" }, who, list)));

  const stateColor: Record<string, string> = {
    idle: "#8E939C", sleeping: "#9492B8",
    working: "#3B9EFF", thinking: "#A78BFA", searching: "#6366F1",
    approval: "#F5A524", question: "#22D3EE", error: "#F4505E",
    finished: "#34D399", ratelimit: "#FB923C", dizzy: "#F472B6",
  };

  return {
    el,
    sync() {
      const task = State.focusTask;
      clear(who);
      if (task) {
        const n = State.sessionList(task.id).length;
        who.append(
          dot(task.color, 7),
          h("span", { class: "name", text: task.name }),
          h("span", { class: "tool", text: n === 1 ? "1 session" : `${n} sessions` }),
        );
      }
      clear(list);
      if (!task) return;
      const active = State.activeSessionId(task.id);
      for (const s of State.sessionList(task.id)) {
        const row = h(
          "div",
          { class: s.id === active ? "session-row active" : "session-row" },
          dot(stateColor[s.state] ?? "#8E939C", 7),
          h("span", { class: "session-name", text: s.label }),
          h("span", { class: "session-step", text: s.steps.at(-1) ?? s.state }),
        );
        row.addEventListener("click", () => {
          State.setActiveSession(task.id, s.id);
          actions.setFocus(task.id);
          actions.setView(State.defaultView());
        });
        list.append(row);
      }
    },
  };
}

// ── Placeholders filled in later stages ───────────────────────────────────────

function buildPlaceholder(title: string, sub: string): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: `padding:0 18px 0 ${CARD_PAD}px` },
    h("div", { class: "title", text: title }),
    h("div", { class: "sub", text: sub }),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildViews(
  actions: ViewActions,
  onChatHeightChange: () => void,
): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildOverview(actions));
  map.set("empty", buildEmpty(actions));
  map.set("approval", buildApproval(actions));
  map.set("question", buildQuestion());
  map.set("error", buildError(actions));
  map.set("finished", buildFinished(actions));
  map.set("confused", buildConfused());
  map.set("note", buildNote());
  map.set("settings", buildSettings(actions));
  map.set("sessions", buildSessions(actions));
  map.set("prompt", buildPrompt(onChatHeightChange));
  map.set("upload", buildUpload());
  map.set("uploading", buildUploading());
  map.set("choose", buildChoose(actions));
  // Not in the Windows v1: sending a file by email, window attach + web result.
  map.set("mail", buildPlaceholder("Sending by email isn't in this version.", ""));
  map.set("searching", buildPlaceholder("Claude is searching…", ""));
  map.set("result", buildPlaceholder("Result", ""));
  return map;
}
