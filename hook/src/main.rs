//! mizuhara-hook — the relay the agent CLI runs on every hook event.
//!
//! Reads the hook JSON on stdin, adds a little terminal context, and hands it to
//! Mizuhara over the named pipe `\\.\pipe\mizuhara-<sid>` (Windows) or the Unix
//! socket `$XDG_RUNTIME_DIR/mizuhara.sock` (Linux).
//!
//! It speaks two dialects:
//! * **Claude Code** — its own event names, and the `PermissionRequest` reply shape.
//! * **Command Code** (`--agent commandcode`) — tool names normalized to the ones
//!   the island knows, and a `PreToolUse` in `default` mode that is turned into an
//!   island approval card, answered back in Command Code's `PreToolUse` shape.
//!
//! Hard rule: **never block the agent.**
//! * If the pipe does not exist — Mizuhara is closed — we exit 0 immediately with
//!   nothing on stdout, and the session carries on untouched.
//! * Every step runs under a deadline enforced by the main thread, so a pipe that
//!   accepts the connection and then stops reading cannot wedge the session
//!   either: we abandon the worker and exit.
//! * Only an approval waits for an answer. No answer means empty stdout, and the
//!   agent's own permission flow continues as if Mizuhara were not installed.
//!
//! Usage: `mizuhara-hook [--agent <name>] [<EventName>]`.

use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::Duration;

use serde_json::Value;

/// Budget for getting a pipe connection. Beyond this the agent wins, always.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);
/// Whole-run budget for an event nobody waits on: connect and write, no more.
const FIRE_AND_FORGET_BUDGET: Duration = Duration::from_secs(2);
/// How long an approval may stay on screen before the terminal takes over.
const DECISION_BUDGET: Duration = Duration::from_secs(110);

/// Fields that are pointless to forward and can be enormous (a whole file read,
/// a full command output). The island never shows them.
const DROPPED_FIELDS: &[&str] = &["tool_response", "transcript_path"];
/// Longest string forwarded for any single field; the island truncates to far
/// less than this anyway.
const MAX_FIELD_LEN: usize = 2_000;

/// How much of a transcript we are willing to read looking for the final message.
const TRANSCRIPT_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// Cap on the final message we attach on Stop (under MAX_FIELD_LEN so the
/// truncation pass below leaves it alone).
const RESULT_MAX_LEN: usize = 1_900;

/// Command Code tools that become an island approval card. Only in `default`
/// mode, where Command Code would have prompted anyway — reads stay silent.
const COMMANDCODE_APPROVAL_TOOLS: &[&str] = &["shell_command", "write_file", "edit_file"];

#[cfg(windows)]
mod win;
#[cfg(windows)]
use win::connect;

#[cfg(target_os = "linux")]
mod unix;
#[cfg(target_os = "linux")]
use unix::connect;

/// How the decision is written back to the agent.
enum Reply {
    /// Claude Code's PermissionRequest shape.
    Claude,
    /// Command Code's PreToolUse shape.
    CommandCode,
}

struct Prepared {
    payload: String,
    /// True when the main thread must keep the pipe open for a decision.
    waits: bool,
    reply: Reply,
}

fn main() {
    let Some(prepared) = prepare() else {
        std::process::exit(0);
    };

    let budget = if prepared.waits {
        DECISION_BUDGET
    } else {
        FIRE_AND_FORGET_BUDGET
    };

    // The worker owns every blocking call. If it overruns the budget we simply
    // stop listening and exit: the process dying takes the pipe handle with it.
    // (No catch_unwind here — the release profile is panic = "abort", so it would
    // be dead code. `talk` is written to have nothing to panic on instead.)
    let (tx, rx) = mpsc::channel::<Option<String>>();
    let payload = prepared.payload;
    let waits = prepared.waits;
    std::thread::spawn(move || {
        let _ = tx.send(talk(&payload, waits));
    });

    if let Ok(Some(decision)) = rx.recv_timeout(budget) {
        if let Some(out) = decision_json(&prepared.reply, &decision) {
            let mut stdout = std::io::stdout();
            let _ = writeln!(stdout, "{out}");
            let _ = stdout.flush();
        }
    }
    // Nothing printed: the agent's own permission flow continues, as if we were
    // not here.
    std::process::exit(0);
}

/// The documented output shape for each agent. Anything we do not recognise
/// prints nothing at all rather than guessing — silence is the safe answer.
/// Claude Code: https://code.claude.com/docs/en/hooks
/// Command Code: https://commandcode.ai/docs/hooks
fn decision_json(reply: &Reply, decision: &str) -> Option<String> {
    let decision = decision.trim();
    let allow = decision == "allow" || decision == "always";
    if !allow && decision != "deny" {
        return None;
    }
    Some(match reply {
        Reply::Claude => {
            if allow {
                r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#
                    .to_string()
            } else {
                r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Mizuhara"}}}"#
                    .to_string()
            }
        }
        Reply::CommandCode => {
            if allow {
                r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}"#
                    .to_string()
            } else {
                r#"{"continue":true,"systemMessage":"Denied from Mizuhara","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Denied from Mizuhara"}}"#
                    .to_string()
            }
        }
    })
}

/// Reads stdin and returns the payload to forward plus how to answer it.
fn prepare() -> Option<Prepared> {
    let mut raw = Vec::new();
    if std::io::stdin().read_to_end(&mut raw).is_err() || raw.is_empty() {
        return None;
    }
    // Some shells hand us a UTF-8 BOM; serde_json would choke on it.
    if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        raw.drain(..3);
    }

    let mut payload = serde_json::from_slice::<Value>(&raw).ok()?;
    payload.as_object_mut()?;

    // Parse argv: "mizuhara-hook.exe [--agent <name>] [<EventName>]"
    // --agent tags the payload with mizuhara_agent so the app routes to the right
    // pill. Absent or invalid names are validated and discarded by the app.
    let mut agent = String::new();
    let mut arg_event = String::new();
    {
        let mut it = std::env::args().skip(1);
        while let Some(arg) = it.next() {
            if arg == "--agent" {
                agent = it.next().unwrap_or_default();
            } else if arg_event.is_empty() {
                arg_event = arg;
            }
        }
    }
    let is_commandcode = agent == "commandcode";

    // Which agent this hook was installed for. Absent means Claude Code, so
    // existing hook commands keep working unchanged.
    if !agent.is_empty() {
        payload
            .as_object_mut()?
            .insert("mizuhara_agent".into(), Value::String(agent));
    }

    let mut event = payload
        .get("hook_event_name")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .unwrap_or(arg_event);

    if is_commandcode {
        event = normalize_commandcode(&mut payload, event);
    }

    payload
        .as_object_mut()?
        .insert("hook_event_name".into(), Value::String(event.clone()));

    // End of a turn: attach the assistant's final message for the "finished" card,
    // read straight from the transcript the agent just wrote. The path is dropped
    // from the payload afterwards; the island never has to open a file itself.
    if event == "Stop" || event == "StopFailure" {
        if let Some(path) = payload.get("transcript_path").and_then(Value::as_str) {
            if let Some(result) = last_assistant_message(path) {
                payload
                    .as_object_mut()?
                    .insert("result".into(), Value::String(result));
            }
        }
    }

    for field in DROPPED_FIELDS {
        payload.as_object_mut()?.remove(*field);
    }

    let cwd_missing = payload
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::is_empty)
        .unwrap_or(true);
    if cwd_missing {
        if let Ok(cwd) = std::env::current_dir() {
            payload.as_object_mut()?.insert(
                "cwd".into(),
                Value::String(cwd.to_string_lossy().to_string()),
            );
        }
    }

    // Which terminal the session runs in. Mizuhara accepts events from every
    // terminal, so this is context only — never a filter.
    for (key, var) in [
        ("term_program", "TERM_PROGRAM"),
        ("wt_session", "WT_SESSION"),
        ("term_session_id", "TERM_SESSION_ID"),
        ("vscode_pid", "VSCODE_PID"),
        ("session_pid", "CLAUDE_CODE_SSE_PORT"),
        ("commandcode_session", "COMMANDCODE_SESSION_ID"),
    ] {
        if payload.get(key).is_none() {
            let value = std::env::var(var).unwrap_or_default();
            payload
                .as_object_mut()?
                .insert(key.into(), Value::String(value));
        }
    }

    truncate_strings(&mut payload);

    let waits = event == "PermissionRequest";
    let reply = if is_commandcode {
        Reply::CommandCode
    } else {
        Reply::Claude
    };

    let mut line = payload.to_string();
    line.push('\n');
    Some(Prepared {
        payload: line,
        waits,
        reply,
    })
}

/// Command Code speaks its own tool names and events. Translate them to what the
/// island understands, and turn a would-be permission prompt into an island
/// approval card. Returns the (possibly rewritten) event name.
fn normalize_commandcode(payload: &mut Value, event: String) -> String {
    let Some(map) = payload.as_object_mut() else {
        return event;
    };

    // shell_command → Bash, read_file → Read, … so the ticker shows a label the
    // island has a translation for instead of a raw tool id.
    let tool = map
        .get("tool_name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if !tool.is_empty() {
        map.insert(
            "tool_name".into(),
            Value::String(commandcode_tool(&tool).to_string()),
        );
    }

    // The island reads `path`; Command Code calls the same thing `absolute_path`.
    if let Some(input) = map.get_mut("tool_input").and_then(Value::as_object_mut) {
        if !input.contains_key("path") {
            if let Some(path) = input.get("absolute_path").cloned() {
                input.insert("path".into(), path);
            }
        }
    }

    // Approval only where Command Code would have prompted anyway, so reads never
    // turn into a card and `auto-accept` / `bypass` sessions stay silent.
    let permission_mode = map
        .get("permission_mode")
        .and_then(Value::as_str)
        .unwrap_or("");
    let needs_approval = event == "PreToolUse"
        && permission_mode == "default"
        && COMMANDCODE_APPROVAL_TOOLS.contains(&tool.as_str());
    if needs_approval {
        return "PermissionRequest".to_string();
    }
    event
}

fn commandcode_tool(name: &str) -> &str {
    match name {
        "shell_command" => "Bash",
        "read_file" => "Read",
        "write_file" => "Write",
        "edit_file" => "Edit",
        other => other,
    }
}

/// The last assistant message in a session transcript (JSONL). Works for Command
/// Code and Claude Code: both write `{"message":{"role":"assistant","content":[…}}]`
/// lines and both mark text blocks with `"type":"text"` (thinking is skipped).
///
/// Scans from the end, so only the final answer is ever built. Reads at most the
/// last `TRANSCRIPT_MAX_BYTES` of a very long file.
fn last_assistant_message(path: &str) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    let bytes = if meta.len() > TRANSCRIPT_MAX_BYTES {
        use std::io::{Seek, SeekFrom};
        let mut file = std::fs::File::open(path).ok()?;
        file.seek(SeekFrom::End(-(TRANSCRIPT_MAX_BYTES as i64))).ok()?;
        let mut buf = Vec::new();
        file.read_to_end(&mut buf).ok()?;
        buf
    } else {
        std::fs::read(path).ok()?
    };

    let text = String::from_utf8_lossy(&bytes);
    for line in text.lines().rev() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else { continue };
        let Some(message) = value.get("message") else { continue };
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(parts) = message.get("content").and_then(Value::as_array) else { continue };
        let mut out = String::new();
        for part in parts {
            if part.get("type").and_then(Value::as_str) != Some("text") {
                continue;
            }
            if let Some(t) = part.get("text").and_then(Value::as_str) {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(t);
            }
        }
        let out = out.trim();
        if !out.is_empty() {
            return Some(truncate_to(out, RESULT_MAX_LEN));
        }
    }
    None
}

/// `s` cut to at most `max` bytes on a char boundary, with an ellipsis.
fn truncate_to(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = s[..end].to_string();
    out.push('…');
    out
}

/// Caps every string in the payload. A single Write can carry a whole file.
fn truncate_strings(value: &mut Value) {
    match value {
        Value::String(s) => {
            if s.len() > MAX_FIELD_LEN {
                // Cut on a char boundary; a lone byte index can split UTF-8.
                let mut end = MAX_FIELD_LEN;
                while end > 0 && !s.is_char_boundary(end) {
                    end -= 1;
                }
                s.truncate(end);
                s.push('…');
            }
        }
        Value::Array(items) => items.iter_mut().for_each(truncate_strings),
        Value::Object(map) => map.values_mut().for_each(truncate_strings),
        _ => {}
    }
}

/// Connect, send, and — for an approval — wait for the island's word.
fn talk(payload: &str, waits_for_answer: bool) -> Option<String> {
    let mut pipe = connect()?;

    if pipe.write_all(payload.as_bytes()).is_err() {
        return None;
    }
    let _ = pipe.flush();

    if !waits_for_answer {
        return None;
    }

    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let answer = String::from_utf8_lossy(&buf).trim().to_string();
    (!answer.is_empty()).then_some(answer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_decisions_match_the_documented_shape() {
        assert_eq!(
            decision_json(&Reply::Claude, "allow").unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#
        );
        assert_eq!(
            decision_json(&Reply::Claude, "deny").unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Mizuhara"}}}"#
        );
        // "always" is an island concept; the agent just gets an allow.
        assert!(decision_json(&Reply::Claude, "always").unwrap().contains(r#""behavior":"allow""#));
    }

    #[test]
    fn commandcode_decisions_use_the_pretooluse_shape() {
        let allow = decision_json(&Reply::CommandCode, "allow").unwrap();
        assert!(allow.contains(r#""permissionDecision":"allow""#));
        assert!(allow.contains(r#""hookEventName":"PreToolUse""#));

        let deny = decision_json(&Reply::CommandCode, "deny").unwrap();
        assert!(deny.contains(r#""permissionDecision":"deny""#));
        assert!(deny.contains("Denied from Mizuhara"));
    }

    #[test]
    fn anything_unrecognised_prints_nothing() {
        assert!(decision_json(&Reply::Claude, "").is_none());
        assert!(decision_json(&Reply::Claude, "maybe").is_none());
        assert!(decision_json(&Reply::CommandCode, "maybe").is_none());
        // The shape the app used to send must not be mistaken for a decision.
        assert!(decision_json(&Reply::Claude, r#"{"permissionDecision":"allow"}"#).is_none());
    }

    #[test]
    fn commandcode_tools_and_paths_are_normalized() {
        assert_eq!(commandcode_tool("shell_command"), "Bash");
        assert_eq!(commandcode_tool("read_file"), "Read");
        assert_eq!(commandcode_tool("write_file"), "Write");
        assert_eq!(commandcode_tool("edit_file"), "Edit");
        assert_eq!(commandcode_tool("something_else"), "something_else");

        let mut payload = json!({
            "hook_event_name": "PreToolUse",
            "tool_name": "read_file",
            "tool_input": { "absolute_path": "C:/x/README.md" },
        });
        assert_eq!(normalize_commandcode(&mut payload, "PreToolUse".into()), "PreToolUse");
        assert_eq!(payload["tool_name"], "Read");
        assert_eq!(payload["tool_input"]["path"], "C:/x/README.md");
    }

    #[test]
    fn only_default_mode_write_tools_become_an_approval() {
        // A shell command in default mode is the case the island approves.
        let mut shell = json!({
            "tool_name": "shell_command",
            "permission_mode": "default",
            "tool_input": { "command": "rm -rf build" },
        });
        assert_eq!(normalize_commandcode(&mut shell, "PreToolUse".into()), "PermissionRequest");

        // A read never turns into a card.
        let mut read = json!({
            "tool_name": "read_file",
            "permission_mode": "default",
            "tool_input": { "absolute_path": "a.txt" },
        });
        assert_eq!(normalize_commandcode(&mut read, "PreToolUse".into()), "PreToolUse");

        // Auto-accept sessions stay silent.
        let mut auto = json!({
            "tool_name": "write_file",
            "permission_mode": "auto-accept",
            "tool_input": { "file_path": "a.txt" },
        });
        assert_eq!(normalize_commandcode(&mut auto, "PreToolUse".into()), "PreToolUse");

        // Other events are left alone.
        let mut stop = json!({ "tool_name": "shell_command", "permission_mode": "default" });
        assert_eq!(normalize_commandcode(&mut stop, "Stop".into()), "Stop");
    }

    #[test]
    fn long_strings_are_cut_on_a_char_boundary() {
        let mut v = json!({ "tool_input": { "content": "é".repeat(4000) } });
        truncate_strings(&mut v);
        let s = v["tool_input"]["content"].as_str().unwrap();
        assert!(s.len() <= MAX_FIELD_LEN + 4);
        assert!(s.ends_with('…'));
    }

    #[test]
    fn the_last_assistant_message_is_read_from_a_transcript() {
        use std::io::Write as _;
        let dir = std::env::temp_dir().join(format!("mizuhara-tx-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        for line in [
            r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#,
            // A thinking-only assistant line must not be mistaken for the answer.
            r#"{"type":"message","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"}]}}"#,
            r#"{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"first"},{"type":"text","text":"answer"}]}}"#,
        ] {
            writeln!(f, "{line}").unwrap();
        }
        drop(f);
        assert_eq!(
            last_assistant_message(path.to_str().unwrap()).as_deref(),
            Some("first\nanswer")
        );
        assert!(last_assistant_message("C:/nope/missing.jsonl").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
