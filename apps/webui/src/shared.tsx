import { useEffect, useState, type ReactNode, type CSSProperties } from "react";
import { api, type HealthReport } from "./api";
import { useT } from "./i18n";

/* ── Input style preset ── */
export const inputStyle: CSSProperties = {
  width: "100%", background: "var(--bg-card)", border: "1px solid var(--border)",
  color: "var(--fg)", padding: "9px 13px", borderRadius: 4,
  fontFamily: "var(--font-sans)", fontSize: 14, outline: "none", boxSizing: "border-box",
};

/* ── PageHeader ── */
export function PageHeader({ title, subtitle, onBack, children }: {
  title: string; subtitle?: string; onBack?: () => void; children?: ReactNode;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", animation: "fadeIn .15s ease both" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        {onBack && (
          <button onClick={onBack} style={{
            background: "transparent", border: "1px solid var(--border)", color: "var(--fg-secondary)",
            padding: "6px 10px", borderRadius: 4, cursor: "pointer", fontSize: 14, fontFamily: "var(--font-mono)",
            lineHeight: 1, marginTop: 2, transition: "all .12s",
          }}
          onMouseEnter={e => { e.currentTarget.style.color = "var(--fg)"; e.currentTarget.style.borderColor = "var(--fg-tertiary)"; }}
          onMouseLeave={e => { e.currentTarget.style.color = "var(--fg-secondary)"; e.currentTarget.style.borderColor = "var(--border)"; }}
          >←</button>
        )}
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.3px", margin: 0, lineHeight: 1.3 }}>{title}</h1>
          {subtitle && <div style={{ color: "var(--fg-secondary)", fontSize: 12, marginTop: 2, fontFamily: "var(--font-mono)" }}>{subtitle}</div>}
        </div>
      </div>
      {children && <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>{children}</div>}
    </div>
  );
}

/* ── StatusBadge ── */
const badgeTone: Record<string, { color: string; bg: string }> = {
  pass:       { color: "var(--green)",  bg: "#e8f3e9" },
  fail:       { color: "var(--red)",    bg: "#fdf0ef" },
  running:    { color: "var(--blue)",   bg: "#e8edf9" },
  cancelled:  { color: "var(--fg-tertiary)", bg: "var(--bg-inset)" },
  online:     { color: "var(--green)",  bg: "#e8f3e9" },
  offline:    { color: "var(--fg-tertiary)", bg: "var(--bg-inset)" },
  busy:       { color: "var(--amber)",  bg: "#fdf4e4" },
  pending:    { color: "var(--fg-tertiary)", bg: "var(--bg-inset)" },
};

export function StatusBadge({ tone, children }: { tone: string; children: string }) {
  const t = badgeTone[tone] ?? badgeTone["pending"];
  return (
    <span style={{
      display: "inline-block", fontSize: 10, fontWeight: 600,
      textTransform: "uppercase", letterSpacing: ".5px",
      padding: "2px 8px", borderRadius: 3, color: t!.color, background: t!.bg,
      fontFamily: "var(--font-sans)",
    }}>{children}</span>
  );
}

/* ── Global runtime health ── */
export function HealthStrip() {
  const { t } = useT();
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const h = await api.health();
        if (!cancelled) { setHealth(h); setFailed(false); }
      } catch {
        if (!cancelled) { setHealth(null); setFailed(true); }
      }
    }
    load();
    const timer = window.setInterval(load, 15000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  const status = failed ? "error" : health?.status ?? "warn";
  const checks = health?.checks ?? [{ name: "http", status: "error" as const, message: t("health.unreachable") }];
  const label = status === "ok" ? t("health.ok") : status === "warn" ? t("health.warn") : t("health.error");
  const toneColor = status === "ok" ? "var(--green)" : status === "warn" ? "var(--amber)" : "var(--red)";

  return (
    <div style={{
      border: "1px solid var(--border)", background: "var(--bg-card)", borderRadius: 4,
      padding: "8px 12px", display: "flex", alignItems: "center", gap: 12,
      minHeight: 36, overflowX: "auto",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, flexShrink: 0 }}>
        <span style={{ width: 7, height: 7, borderRadius: 7, background: toneColor, display: "inline-block" }} />
        <span style={{ fontSize: 11, fontWeight: 700, fontFamily: "var(--font-mono)", color: toneColor, textTransform: "uppercase" }}>{label}</span>
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}>
        {checks.map(c => {
          const cColor = c.status === "ok" ? "var(--green)" : c.status === "warn" ? "var(--amber)" : "var(--red)";
          return (
            <span key={c.name} title={c.message} style={{
              display: "inline-flex", alignItems: "center", gap: 5, border: "1px solid var(--border-light)",
              background: "var(--bg-inset)", borderRadius: 3, padding: "3px 7px", flexShrink: 0,
              fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--fg-secondary)",
            }}>
              <span style={{ width: 5, height: 5, borderRadius: 5, background: cColor }} />
              {c.name}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/* ── SectionHeader ── */
export function SectionHeader({ children, onViewAll }: { children: string; onViewAll?: (() => void) | undefined }) {
  const { t } = useT();
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 1, color: "var(--fg-tertiary)", fontWeight: 600 }}>
        {children}
      </div>
      {onViewAll && (
        <button onClick={onViewAll} style={{
          background: "transparent", border: "none", color: "var(--fg-tertiary)",
          cursor: "pointer", fontSize: 11, fontFamily: "var(--font-sans)",
          padding: "2px 0", transition: "color .12s",
        }}
        onMouseEnter={e => { e.currentTarget.style.color = "var(--fg-secondary)"; }}
        onMouseLeave={e => { e.currentTarget.style.color = "var(--fg-tertiary)"; }}
        >{t("dash.viewAll")} →</button>
      )}
    </div>
  );
}

/* ── EmptyState ── */
export function EmptyState({ icon, title, hint }: { icon: string; title: string; hint?: string }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      padding: "48px 20px", gap: 8, animation: "fadeIn .3s ease both",
    }}>
      <div style={{ fontSize: 28, opacity: .4, marginBottom: 4 }}>{icon}</div>
      <div style={{ fontSize: 13, color: "var(--fg-secondary)", fontWeight: 500 }}>{title}</div>
      {hint && <div style={{ fontSize: 11, color: "var(--fg-tertiary)", fontFamily: "var(--font-mono)" }}>{hint}</div>}
    </div>
  );
}

/* ── Skeleton (shimmer placeholder) ── */
export function Skeleton({ w, h = 14, br = 4 }: { w?: number | string; h?: number; br?: number }) {
  return <div className="skeleton" style={{ width: w ?? "100%", height: h, borderRadius: br }} />;
}

/* ── Confidence bar ── */
export function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.min(100, Math.max(0, Math.round(value * 100)));
  const color = pct >= 80 ? "var(--green)" : pct >= 50 ? "var(--amber)" : "var(--red)";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "var(--font-mono)", fontSize: 11 }}>
      <span style={{ width: 32, height: 3, background: "var(--border-light)", borderRadius: 2, overflow: "hidden", display: "inline-block" }}>
        <span style={{ display: "block", width: `${pct}%`, height: "100%", background: color, borderRadius: 2, transition: "width .3s" }} />
      </span>
      <span style={{ color: "var(--fg-tertiary)", minWidth: 24, textAlign: "right" }}>{pct}%</span>
    </span>
  );
}

/* ── Btn ── */
export function Btn({ onClick, children, ghost, tone }: {
  onClick: () => void; children: ReactNode; ghost?: boolean; tone?: "danger";
}) {
  const dangerColor = tone === "danger" ? "var(--red)" : undefined;
  return (
    <button onClick={onClick} style={{
      background: ghost ? "transparent" : (dangerColor ?? "var(--fg)"),
      color: ghost ? (dangerColor ?? "var(--fg)") : "var(--bg-card)",
      border: ghost ? `1px solid ${dangerColor ?? "var(--border)"}` : "none",
      padding: "8px 20px", borderRadius: 4, fontFamily: "var(--font-sans)", fontSize: 13,
      fontWeight: 600, cursor: "pointer", letterSpacing: "-0.2px",
      transition: "opacity .12s, background .12s",
    }}
    onMouseEnter={e => { e.currentTarget.style.opacity = "0.85"; }}
    onMouseLeave={e => { e.currentTarget.style.opacity = "1"; }}
    >{children}</button>
  );
}

/* ── StepIcon ── */
export function StepIcon({ status }: { status: "done" | "running" | "fail" | "pending" }) {
  const map = {
    done:    { icon: "✓", color: "var(--green)" },
    running: { icon: "●", color: "var(--blue)" },
    fail:    { icon: "✗", color: "var(--red)" },
    pending: { icon: "—", color: "var(--border)" },
  };
  const m = map[status];
  return (
    <span style={{
      fontFamily: "var(--font-mono)", fontSize: 12, width: 16, textAlign: "center",
      color: m.color, animation: status === "running" ? "pulse 1.5s infinite" : "none",
      display: "inline-block",
    }}>{m.icon}</span>
  );
}

/* ── Field helper ── */
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: "var(--fg-secondary)", marginBottom: 4, textTransform: "uppercase", letterSpacing: ".5px" }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 10, color: "var(--fg-tertiary)", marginTop: 3, fontFamily: "var(--font-mono)" }}>{hint}</div>}
    </div>
  );
}

/* ── TabBtn ── */
export function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button onClick={onClick} style={{
      padding: "7px 18px", border: "none",
      background: active ? "var(--fg)" : "transparent",
      color: active ? "var(--bg-card)" : "var(--fg-secondary)",
      cursor: "pointer", borderRadius: 4, fontSize: 13, fontWeight: 600,
      fontFamily: "var(--font-sans)", transition: "all .12s",
    }}>{children}</button>
  );
}
