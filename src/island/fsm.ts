// Island open/close FSM — port of IslandStateMachine.swift, driven by hover.
//
// No DOM, no Tauri: it only reports transitions. The island is idle as a small
// horizontal bar ("hidden") and opens the moment the cursor reaches it; when the
// cursor leaves it closes again after a short grace, instead of waiting out long
// timers. An alert that is waiting for an answer stays open (pinned).

export type FsmState = "hidden" | "petit" | "home" | "mizuhara";

export class IslandStateMachine {
  state: FsmState = "hidden";

  onTransition: ((from: FsmState, to: FsmState) => void) | null = null;

  /** Grace before closing once the cursor has left, seconds. */
  closeDelay = 0.35;
  /** mizuhara → hidden once the greeting animation ends (no hover). */
  greetAutoCollapseDelay = 0.6;
  /** mizuhara → hidden while the mouse hovers the greeting. */
  greetHoverCollapseDelay = 10;
  /** An alert waiting for an answer stays open, even when the mouse leaves. */
  pinned = false;

  private hide: number | null = null;
  private greetCollapse: number | null = null;

  // ── Inputs ──────────────────────────────────────────────────────────────────

  launch() {
    this.cancelTimers();
    this.transition("mizuhara");
  }

  /** Cursor on the island: open it, or keep an open one open. */
  mouseEntered() {
    switch (this.state) {
      case "hidden":
      case "petit":
        this.cancelTimers();
        this.transition("home");
        break;
      case "home":
        this.clear("hide");
        break;
      case "mizuhara":
        this.scheduleGreetCollapse(this.greetHoverCollapseDelay);
        break;
    }
  }

  /** Cursor away (or an event opened the island while the cursor was elsewhere). */
  mouseLeft() {
    switch (this.state) {
      case "hidden":
      case "petit":
        break;
      case "home":
        this.scheduleHide();
        break;
      case "mizuhara":
        break;
    }
  }

  click() {
    if (this.state === "home") return;
    this.cancelTimers();
    this.transition("home");
  }

  /** Greeting animation finished (T.end). Doesn't override a running hover timer. */
  greetComplete() {
    if (this.state !== "mizuhara") return;
    if (this.greetCollapse == null) this.scheduleGreetCollapse(this.greetAutoCollapseDelay);
  }

  /** Alert or explicit request: open straight to expanded. */
  forceHome() {
    this.cancelTimers();
    this.transition("home");
  }

  /// Explicit close (OK button, Escape, an alert being answered).
  forcePetit() {
    this.cancelTimers();
    this.transition("hidden");
  }

  forceHidden() {
    this.cancelTimers();
    this.transition("hidden");
  }

  // ── Timers ──────────────────────────────────────────────────────────────────

  /** Idempotent: the cursor poll calls this every tick while the cursor is away. */
  private scheduleHide() {
    if (this.hide != null || this.pinned) return;
    this.hide = window.setTimeout(() => {
      this.hide = null;
      if (this.state === "home") this.transition("hidden");
    }, this.closeDelay * 1000);
  }

  private scheduleGreetCollapse(delay: number) {
    this.clear("greetCollapse");
    this.greetCollapse = window.setTimeout(() => {
      this.greetCollapse = null;
      if (this.state === "mizuhara") this.transition("hidden");
    }, delay * 1000);
  }

  private clear(which: "hide" | "greetCollapse") {
    const id = this[which];
    if (id != null) window.clearTimeout(id);
    this[which] = null;
  }

  cancelTimers() {
    this.clear("hide");
    this.clear("greetCollapse");
  }

  private transition(next: FsmState) {
    if (next === this.state) return;
    const from = this.state;
    this.state = next;
    this.onTransition?.(from, next);
  }
}
