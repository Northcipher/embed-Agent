import { useState } from "react";
import { I18nProvider, useT } from "./i18n";
import { Dashboard } from "./Dashboard";
import { StartRun } from "./StartRun";
import { History } from "./History";
import { RunDetail } from "./RunDetail";

type View = "dash" | "start" | "hist" | { run: string };

export function App() {
  return <I18nProvider><AppInner /></I18nProvider>;
}

function AppInner() {
  const [view, setView] = useState<View>("dash");
  const { t, toggle } = useT();

  return (
    <div style={{ display: "flex", height: "100vh", background: "var(--bg)", color: "var(--fg)", fontFamily: "var(--font-sans)" }}>
      <nav style={{ width: 56, background: "var(--bg-card)", borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", alignItems: "center", padding: "20px 0", gap: 4, flexShrink: 0 }}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 20, letterSpacing: "-0.5px" }}>EA</div>
        <NavBtn icon="⌂" active={view === "dash"} onClick={() => setView("dash")} />
        <NavBtn icon="+" active={view === "start"} onClick={() => setView("start")} />
        <NavBtn icon="⌕" active={view === "hist"} onClick={() => setView("hist")} />
        <div style={{ flex: 1 }} />
        <button onClick={toggle} title={t("lang.switch")} style={{ width: 36, height: 36, border: "none", background: "transparent", color: "var(--fg-tertiary)", cursor: "pointer", borderRadius: 8, fontSize: 11, fontWeight: 600, fontFamily: "var(--font-mono)", marginBottom: 8 }}>
          {t("lang.switch")}
        </button>
      </nav>
      <main style={{ flex: 1, overflow: "auto", padding: "32px 40px" }}>
        {view === "dash" ? <Dashboard onViewRun={(id) => setView({ run: id })} onStart={() => setView("start")} /> :
         view === "start" ? <StartRun onBack={() => setView("dash")} onCreated={(id) => setView({ run: id })} /> :
         view === "hist" ? <History onViewRun={(id) => setView({ run: id })} /> :
         typeof view === "object" ? <RunDetail runId={view.run} onBack={() => setView("dash")} /> :
         null}
      </main>
    </div>
  );
}

function NavBtn({ icon, active, onClick }: { icon: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ width: 36, height: 36, border: "none", background: active ? "var(--bg-active)" : "transparent", color: active ? "var(--fg)" : "var(--fg-tertiary)", cursor: "pointer", borderRadius: 8, fontSize: 15, display: "flex", alignItems: "center", justifyContent: "center", transition: "all .12s" }}>
      {icon}
    </button>
  );
}
