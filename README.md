<div align="center">

<img src="src-tauri/icons/128x128.png" width="96" alt="Mizuhara icon">

# Mizuhara

**A tiny friend that lives at the top of your screen and keeps an eye on your AI
coding agents — Claude Code and Command Code, live, with approvals from the island.**

Watch your agents work, approve or deny their commands, drop a file, chat — without
leaving what you're doing.

![Windows 10/11](https://img.shields.io/badge/Windows-10%2F11-0078D4?logo=windows)
![Tauri 2](https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=black)
![Rust](https://img.shields.io/badge/Rust-backend-000?logo=rust)

</div>

<img src="screenshots/greeting.png" width="640" alt="Mizuhara waving hello at launch">

---

## What this is

Mizuhara is a small Windows companion that lives at the top of your screen. The
character that lives in the island is also called **Mizuhara**.

It shows your AI coding agent sessions in a slim panel at the top-centre of the
screen — every step, every file it edits, every command it runs — and lets you
answer it from the island instead of switching to the terminal.

## Features

- 🤖 **Claude Code and Command Code, live** — every session shows up in the island:
  what it reads, edits and runs, step by step. Any other tool that can run a
  command on hook events can join in too (`--agent <name>`).
- ✅ **Allow / Deny from the island** — Claude Code permission requests and
  Command Code `shell` / `write` / `edit` requests in the default permission
  mode. One click, or let the terminal handle it.
- 💬 **Chat with Claude** — bring your own Anthropic API key (stored in the Windows
  Credential Manager, never on disk).
- 📎 **Drop a file on the island** — ask a question about it.
- 🔌 **Integrations** — Stripe, n8n, GitHub, Vercel, Resend, Notion, Cal.com, each
  with its own coloured mini character.
- 🎵 **A real character** — idle breathing, blinks, eyes that follow your cursor,
  emotes, sounds, a greeting on launch.
- 🫥 **Invisible when idle** — hides away when nothing is running, peeks out when
  you hover the top edge.
- 🔒 **Private by design** — no telemetry, no account. Keys live in the Windows
  Credential Manager and only the services you configure are ever contacted.

## Command Code integration

Command Code has a [hooks](https://commandcode.ai/docs/hooks) system that fires
`SessionStart`, `PreToolUse`, `PostToolUse` and `Stop` with a JSON payload, and a
`PreToolUse` hook can **block** a tool by returning `permissionDecision: "deny"`.
Mizuhara uses exactly that:

- **Live progress** — every session shows up on a **Command Code** pill. Tool names
  (`shell_command`, `read_file`, `write_file`, `edit_file`) are normalized to the
  labels the island already knows, so the ticker reads `Exécute · …`, `Lit · …`,
  `Écrit · …`, `Modifie · …`.
- **Approve from the island** — in the `default` permission mode (where Command Code
  would have prompted anyway), a `PreToolUse` for a shell command, a write or an
  edit is turned into an island **Allow / Deny** card. `auto-accept` and `bypass`
  sessions stay silent, and reads never raise a card.
- **Never blocked** — if Mizuhara isn't running, the relay exits immediately and
  Command Code's own permission flow continues as if the hooks weren't installed.

### Install it

1. Open **Settings… → Command Code → Install hooks…**
2. Review the exact diff of `%USERPROFILE%\.commandcode\settings.json`, then
   **Back up and write**. A dated backup is taken first, and your own hooks are
   never touched.
3. Start a **new** Command Code session (`cmd`) in any project.

Uninstalling removes only Mizuhara's entries.

> **Timeout note:** if the island shows a card and you never answer, the relay
> gives up after ~110 s and prints nothing. Command Code treats "no opinion" as
> allow, so the tool then runs. Keep an eye on the island when a card is waiting,
> or answer it. If Mizuhara is closed, this never happens — Command Code asks in
> the terminal as usual.

## Using it

| What you do | What happens |
|---|---|
| Move the mouse to the very top-centre of the screen | Mizuhara peeks out |
| Click the small island | It opens |
| Click the character | It gets annoyed. Three times in a row and it goes dizzy |
| Drag a file onto the island | It turns into a box, swallows it, then offers to answer questions about it |
| `Esc` | Closes the island |
| Tray icon | Open, Settings…, Pause, Quit |

## Build it yourself

You need [Rust](https://rustup.rs), [Node 20+](https://nodejs.org), and the
**MSVC build tools** (Visual Studio Build Tools with "Desktop development with
C++"). WebView2 ships with Windows 10/11.

```powershell
cd C:\Users\putra\Documents\mine_project\Mizuhara
npm install
npm run tauri dev      # live-reloading development build
npm run pack           # builds the installer into release/
```

`npm run build` typechecks the front end and builds the relay in one go.

The 29 WAV sounds live in `sounds/` (declared once in `vite.config.ts` → `SOUNDS_DIR`).

### Layout

```
Mizuhara/
  src/                 island front end (TypeScript, no framework)
    mizuhara/          the character and the launch greeting, in Canvas 2D
    island/            state machine, hooks, integrations
    views/             every island view
    settings/          the settings window
  src-tauri/           Rust backend: window, named pipe, Claude API, pollers
  hook/                mizuhara-hook.exe, the agent hook relay
  sounds/              the 29 WAVs
  scripts/             icon generator, pack
```

### Log

`%LOCALAPPDATA%\Mizuhara\mizuhara.log` — hook events, permission decisions, poller
problems. It stays on your machine.

## Supported agents

The relay (`mizuhara-hook.exe`) works with any tool that can run a command on hook
events. `--agent <name>` gives the session its own pill.

| Agent | How to connect | Config file |
|---|---|---|
| Claude Code | **Settings → Claude Code → Install hooks** | `%USERPROFILE%\.claude\settings.json` |
| Command Code | **Settings → Command Code → Install hooks** | `%USERPROFILE%\.commandcode\settings.json` |
| Any other | `--agent <name>` + your tool's hook config | your tool's config file |

Name rule: `^[a-z0-9-]{1,24}$`; `claude` is reserved.
