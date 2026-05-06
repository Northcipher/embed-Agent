import { useEffect, useState } from "react";
import { I18nProvider, useT } from "./i18n";
import { Dashboard } from "./Dashboard";
import { NewRun } from "./StartRun";
import { History } from "./History";
import { RunMonitor } from "./RunMonitor";
import { RunResult } from "./RunResult";
import { Settings } from "./Settings";
import { HealthStrip } from "./shared";

type View = "dash" | "start" | "hist" | "settings" | { run: string } | { result: string };

export function App() {
  return <I18nProvider><AppInner /></I18nProvider>;
}

function AppInner() {
  const [view, setViewState] = useState<View>(() => viewFromHash(window.location.hash));
  const [navOpen, setNavOpen] = useState(false);
  const { t, toggle } = useT();

  useEffect(() => {
    function onHashChange(): void {
      setViewState(viewFromHash(window.location.hash));
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  function setView(next: View): void {
    const hash = hashFromView(next);
    if (window.location.hash === hash) {
      setViewState(next);
      return;
    }
    window.location.hash = hash;
  }

  const isRunMonitor = typeof view === "object" && "run" in view;
  const isRunResult = typeof view === "object" && "result" in view;

  const navItems: { id: View; icon: string; label: string }[] = [
    { id: "dash", icon: "◎", label: t("nav.dashboard") },
    { id: "start", icon: "⊕", label: t("nav.newRun") },
    { id: "hist", icon: "◫", label: t("nav.history") },
    { id: "settings", icon: "⚙", label: t("nav.settings") },
  ];

  function isActive(item: View): boolean {
    if (typeof item === "string" && typeof view === "string") return item === view;
    if (item === "dash" && view === "dash") return true;
    if (item === "start" && view === "start") return true;
    if (item === "hist" && view === "hist") return true;
    if (item === "settings" && view === "settings") return true;
    return false;
  }

  const sidebarW = navOpen ? "var(--sidebar-w-open)" : "var(--sidebar-w)";

  return (
    <div style={{ display: "flex", height: "100vh", background: "var(--bg)", color: "var(--fg)", fontFamily: "var(--font-sans)" }}>
      {/* Sidebar */}
      <nav
        onMouseEnter={() => setNavOpen(true)}
        onMouseLeave={() => setNavOpen(false)}
        style={{
          width: sidebarW, background: "var(--bg-card)", borderRight: "1px solid var(--border)",
          display: "flex", flexDirection: "column", alignItems: "stretch", padding: "18px 0", gap: 2,
          flexShrink: 0, transition: "width .15s ease", overflow: "hidden", whiteSpace: "nowrap",
          userSelect: "none", zIndex: 10,
        }}
      >
        {/* Logo */}
        <div style={{ padding: "0 16px", marginBottom: 20, display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.5px", color: "var(--fg)", flexShrink: 0 }}>EA</span>
          <span style={{ fontSize: 12, fontWeight: 500, color: "var(--fg-tertiary)", opacity: navOpen ? 1 : 0, transition: "opacity .1s" }}>Embed Agent</span>
        </div>

        {/* Nav items */}
        {navItems.map(item => {
          const active = isActive(item.id);
          const navId = typeof item.id === "string" ? item.id : "";
          return (
            <button
              key={navId}
              onClick={() => setView(item.id)}
              style={{
                display: "flex", alignItems: "center", gap: 10,
                margin: "0 8px", padding: "8px 10px", border: "none", borderRadius: 4,
                background: active ? "var(--bg-active)" : "transparent",
                color: active ? "var(--fg)" : "var(--fg-tertiary)",
                cursor: "pointer", fontSize: 13, fontWeight: active ? 600 : 400,
                fontFamily: "var(--font-sans)", transition: "all .12s",
                textAlign: "left", width: "auto",
              }}
            >
              <span style={{ fontSize: 14, width: 18, textAlign: "center", flexShrink: 0, fontFamily: "var(--font-mono)" }}>{item.icon}</span>
              <span style={{ opacity: navOpen ? 1 : 0, transition: "opacity .08s", fontSize: 12 }}>{item.label}</span>
            </button>
          );
        })}

        <div style={{ flex: 1 }} />

        {/* Lang toggle */}
        <button
          onClick={toggle}
          title={t("lang.switch")}
          style={{
            margin: "0 8px", padding: "8px 10px", border: "none", borderRadius: 4,
            background: "transparent", color: "var(--fg-tertiary)", cursor: "pointer",
            fontSize: 11, fontWeight: 600, fontFamily: "var(--font-mono)",
            display: "flex", alignItems: "center", gap: 10,
          }}
        >
          <span style={{ width: 18, textAlign: "center", flexShrink: 0 }}>{t("lang.badge")}</span>
          <span style={{ opacity: navOpen ? 1 : 0, transition: "opacity .08s", fontSize: 11, color: "var(--fg-tertiary)" }}>
            {t("lang.toggleText")}
          </span>
        </button>
      </nav>

      {/* Main */}
      <main style={{ flex: 1, overflow: "auto", padding: "22px 32px 32px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <HealthStrip />
          {view === "dash" ? <Dashboard onViewRun={(id) => setView({ run: id })} onViewResult={(id) => setView({ result: id })} onStart={() => setView("start")} onViewHistory={() => setView("hist")} /> :
           view === "start" ? <NewRun onBack={() => setView("dash")} onCreated={(id) => setView({ run: id })} /> :
           view === "hist" ? <History onViewRun={(id) => setView({ run: id })} onViewResult={(id) => setView({ result: id })} onBack={() => setView("dash")} /> :
           view === "settings" ? <Settings onBack={() => setView("dash")} /> :
           isRunMonitor ? <RunMonitor runId={(view as { run: string }).run} onBack={() => setView("dash")} onCompleted={() => setView({ result: (view as { run: string }).run })} /> :
           isRunResult ? <RunResult runId={(view as { result: string }).result} onBack={() => setView("dash")} /> :
           null}
        </div>
      </main>
    </div>
  );
}

function viewFromHash(hash: string): View {
  const h = hash.replace(/^#\/?/, "");
  const parts = h.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "start") return "start";
  if (parts[0] === "history") return "hist";
  if (parts[0] === "settings") return "settings";
  if (parts[0] === "runs" && parts[1]) return { run: parts[1] };
  if (parts[0] === "results" && parts[1]) return { result: parts[1] };
  return "dash";
}

function hashFromView(view: View): string {
  if (typeof view === "object" && "run" in view) return `#/runs/${encodeURIComponent(view.run)}`;
  if (typeof view === "object" && "result" in view) return `#/results/${encodeURIComponent(view.result)}`;
  if (view === "start") return "#/start";
  if (view === "hist") return "#/history";
  if (view === "settings") return "#/settings";
  return "#/";
}
