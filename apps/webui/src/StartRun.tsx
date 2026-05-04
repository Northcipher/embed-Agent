import { useState, useEffect } from "react";
import { api, type Target } from "./api";
import { Header, Btn } from "./Dashboard";
import { useT } from "./i18n";

export function StartRun({ onBack, onCreated }: { onBack: () => void; onCreated: (id: string) => void }) {
  const { t } = useT();
  const [targets, setTargets] = useState<Target[]>([]);
  const [target, setTarget] = useState("");
  const [artifact, setArtifact] = useState("/tmp/test-fw.bin");
  const [type, setType] = useState("firmware");
  const [expected, setExpected] = useState("Device boots, network up, shell responds");
  const [maxDur, setMaxDur] = useState(180);
  const [noFlash, setNoFlash] = useState(true);
  const [allowShell, setAllowShell] = useState(true);
  const [status, setStatus] = useState("");

  useEffect(() => { api.targets().then(ts => { setTargets(ts.filter(t2 => t2.state !== "offline")); if (ts[0]) setTarget(ts[0].target_id); }).catch(() => {}); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setStatus(t("start.starting"));
    try {
      const r = await api.validate({ artifact: { path: artifact, type }, target, expected, constraints: { max_duration_sec: maxDur, allow_flash: !noFlash, allow_shell_exec: allowShell, no_flash: noFlash } });
      if (r.status === "accepted" && r.run_id) { onCreated(r.run_id); } else { setStatus(r.status + ": " + (r.reasons?.join("; ") ?? "")); }
    } catch (e: any) { setStatus("Error: " + e.message); }
  }

  const f = { display: "flex", flexDirection: "column" as const, gap: 28 };
  const row = { display: "flex", gap: 14 };
  const is = { width: "100%", background: "var(--bg-card)", border: "1px solid var(--border)", color: "var(--fg)", padding: "9px 13px", borderRadius: 6, fontFamily: "var(--font-sans)", fontSize: 14, outline: "none", boxSizing: "border-box" } as const;
  const field = (label: string, el: any) => <div style={{ flex: 1, marginBottom: 16 }}><div style={{ fontSize: 11, fontWeight: 500, color: "var(--fg-secondary)", marginBottom: 5, textTransform: "uppercase", letterSpacing: ".5px" }}>{label}</div>{el}</div>;

  return (
    <div style={f}>
      <Header title={t("start.title")}><Btn ghost onClick={onBack}>← {t("detail.back")}</Btn></Header>
      <form onSubmit={submit} style={f}>
        <div style={row}>
          {field(t("start.target"), <select value={target} onChange={e => setTarget(e.target.value)} style={is}><option value="">{t("start.selectTarget")}</option>{targets.map(t2 => <option key={t2.target_id} value={t2.target_id}>{t2.target_id}</option>)}</select>)}
          {field(t("start.type"), <select value={type} onChange={e => setType(e.target.value)} style={is}><option value="firmware">Firmware</option><option value="apk">APK</option><option value="binary">Binary</option></select>)}
        </div>
        {field(t("start.artifact"), <input value={artifact} onChange={(e: any) => setArtifact(e.target.value)} style={is} />)}
        {field(t("start.expected"), <textarea value={expected} onChange={e => setExpected(e.target.value)} rows={2} style={{ ...is, resize: "vertical" }} />)}
        <div style={row}>
          {field(t("start.maxDuration"), <input type="number" value={maxDur} onChange={(e: any) => setMaxDur(Number(e.target.value))} style={is} />)}
          {field(t("start.version"), <input placeholder="v2.0" style={is} />)}
        </div>
        <div style={{ display: "flex", gap: 16, fontSize: 13, marginBottom: 16 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}><input type="checkbox" checked={allowShell} onChange={e => setAllowShell(e.target.checked)} /> {t("start.allowShell")}</label>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}><input type="checkbox" checked={noFlash} onChange={e => setNoFlash(e.target.checked)} /> {t("start.noFlash")}</label>
        </div>
        <div><Btn onClick={() => {}}>{t("start.submit")}</Btn></div>
        {status && <div style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: status.startsWith("Error") ? "var(--red)" : "var(--fg-secondary)", marginTop: 8 }}>{status}</div>}
      </form>
    </div>
  );
}
