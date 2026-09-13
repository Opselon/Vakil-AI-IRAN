// ────────────────────────────────────────────────────────────────────────────
// ErrorTraceLog — single-file inlined implementation (API-compatible with the
// bot's ./ErrorTraceLog.js module: every member the worker code touches is
// implemented: startPhase/endPhase/addLog/addBreadcrumb/pushStack/popStack/
// setBudgetLimit/setWarningThreshold/generateDiagnostic/formatSummary/
// currentPhase/logs/breadcrumbs).
// Diagnostics-only: it never influences request outcomes and never throws.
// ────────────────────────────────────────────────────────────────────────────
class ErrorTraceLog {
  constructor(requestId, meta = {}, opts = {}) {
    this.requestId = requestId || "req-unknown";
    this.meta = meta || {};
    this.logs = [];
    this.breadcrumbs = [];
    this.stack = [];
    this.currentPhase = null;
    this.budgetLimitMs = Number(opts.budgetLimitMs) || 27500;
    this.warningThresholdMs = Math.floor(this.budgetLimitMs * 0.75);
    this.environment = opts.environment || "production";
    this.mirrorConsole = Boolean(opts.enableConsoleMirroring);
    this.includeDebugInDiagnostics = Boolean(opts.includeDebugInDiagnostics);
    this.createdAt = Date.now();
  }

  setBudgetLimit(ms) {
    const n = Number(ms);
    if (Number.isFinite(n) && n > 0) this.budgetLimitMs = n;
  }

  setWarningThreshold(ms) {
    const n = Number(ms);
    if (Number.isFinite(n) && n > 0) this.warningThresholdMs = n;
  }

  pushStack(name) { this.stack.push(String(name || "unnamed")); }

  popStack() { return this.stack.pop(); }

  startPhase(name, extra = {}) {
    this.currentPhase = { name: String(name || "phase"), startedAt: Date.now(), extra, parent: this.currentPhase };
    return this.currentPhase;
  }

  endPhase(name) {
    if (!this.currentPhase) return null;
    const duration = Date.now() - this.currentPhase.startedAt;
    const done = this.currentPhase;
    this.addLog(duration > this.warningThresholdMs ? "WARN" : "INFO", `phase_done:${done.name}`, { duration_ms: duration });
    this.currentPhase = done.parent || null;
    return done;
  }

  addLog(level, event, data) {
    try {
      const entry = {
        ts: new Date().toISOString(),
        level: String(level || "INFO").toUpperCase(),
        event: String(event || ""),
        phase: this.currentPhase?.name,
        data: this._safe(data)
      };
      this.logs.push(entry);
      if (this.logs.length > 300) this.logs.splice(0, this.logs.length - 300);
      if (this.mirrorConsole && (entry.level === "ERROR" || entry.level === "CRITICAL")) {
        console.error(JSON.stringify({ request_id: this.requestId, ...entry }));
      }
      return entry;
    } catch { return null; }
  }

  addBreadcrumb(event, category, data) {
    try {
      this.breadcrumbs.push({ ts: Date.now(), event: String(event || ""), category: String(category || "misc"), data: this._safe(data) });
      if (this.breadcrumbs.length > 100) this.breadcrumbs.splice(0, this.breadcrumbs.length - 100);
    } catch {}
  }

  formatSummary() {
    try {
      const errors = this.logs.filter(l => l.level === "ERROR" || l.level === "CRITICAL").length;
      return `${this.logs.length} logs · ${errors} errors · phases: ${this.breadcrumbs.length} breadcrumbs`;
    } catch { return "trace summary unavailable"; }
  }

  generateDiagnostic(err, opts = {}) {
    const now = Date.now();
    const diag = {
      request_id: this.requestId,
      environment: this.environment,
      elapsed_ms: now - this.createdAt,
      budget_limit_ms: this.budgetLimitMs,
      over_budget: now - this.createdAt > this.budgetLimitMs,
      error: {
        name: err?.name,
        message: typeof err?.message === "string" ? String(err.message).slice(0, 900) : String(err ?? "UNKNOWN"),
        stack: typeof err?.stack === "string" ? String(err.stack).slice(0, 1400) : undefined,
        code: err?.code,
        httpStatus: err?.httpStatus
      },
      recent_logs: this.logs.slice(-40),
      breadcrumbs: this.breadcrumbs.slice(-40)
    };
    if (opts.includeDebugLogs && this.includeDebugInDiagnostics) diag.full_logs = this.logs;
    return diag;
  }

  _safe(data) {
    try {
      const seen = new WeakSet();
      return JSON.parse(JSON.stringify(data ?? null, (k, v) => {
        if (typeof v === "string" && v.length > 2000) return v.slice(0, 2000) + "…";
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) return "[Circular]";
          seen.add(v);
        }
        return v;
      }));
    } catch { return String(data ?? "").slice(0, 500); }
  }
}
