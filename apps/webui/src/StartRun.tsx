import { useState, useEffect } from "react";
import { api, type Target } from "./api";
import { Header, Btn } from "./Dashboard";

export function StartRun({ onBack, onCreated }: { onBack: () => void; onCreated: (id: string) => void }) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [target, setTarget] = useState("");
  const [artifact, setArtifact] = useState("/tmp/test-fw.bin");
  const [type, setType] = useState("firmware");
  const [expected, setExpected] = useState("Device boots, network up, shell responds");
  const [maxDur, setMaxDur] = useState(180);
  const [noFlash, setNoFlash] = useState(true);
  const [allowShell, setAllowShell] = useState(true);
  const [status, setStatus] = useState("");

  useEffect(() => { api.targets().then(ts => { setTargets(ts.filter(t => t.state !== "offline")); if (ts[0]) setTarget(ts[0].target_id); }).catch(() => {}); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setStatus("Starting...");
    try {
      const r = await api.validate({ artifact: { path: artifact, type }, target, expected, constraints: { max_duration_sec: maxDur, allow_flash: !noFlash, allow_shell_exec: allowShell, no_flash: noFlash } });
      if (r.status === "accepted" && r.run_id) { onCreated(r.run_id); } else { setStatus(r.status + ": " + (r.reasons?.join("; ") ?? "")); }
    } catch (e: any) { setStatus("Error: " + e.message); }
  }

  const f = { display: "flex", flexDirection: "column" as const, gap: 28 };
  const row = { display: "flex", gap: 14 };
  const inputStyle = { width: "100%", background: "var(--bg-card)", border: "1px solid var(--border)", color: "var(--fg)", padding: "9px 13px", borderRadius: 6, fontFamily: "var(--font-sans)", fontSize: 14, outline: "none", boxSizing: "border-box" } as const;
  const field = (label: string, el: any) => <div style={{ flex: 1, marginBottom: 16 }}><div style={{ fontSize: 11, fontWeight: 500, color: "var(--fg-secondary)", marginBottom: 5, textTransform: "uppercase", letterSpacing: ".5px" }}>{label}</div>{el}</div>;

  return (
    <div style={f}>
      <Header title="New Validation"><Btn ghost onClick={onBack}>← Back</Btn></Header>
      <form onSubmit={submit} style={f}>
        <div style={row}>
          {field("Target", <select value={target} onChange={e => setTarget(e.target.value)} style={inputStyle}><option value="">Select...</option>{targets.map(t => <option key={t.target_id} value={t.target_id}>{t.target_id}</option>)}</select>)}
          {field("Type", <select value={type} onChange={e => setType(e.target.value)} style={inputStyle}><option value="firmware">Firmware</option><option value="apk">APK</option><option value="binary">Binary</option></select>)}
        </div>
        {field("Artifact Path", <input value={artifact} onChange={(e: any) => setArtifact(e.target.value)} style={inputStyle} />)}
        {field("Expected Outcome", <textarea value={expected} onChange={e => setExpected(e.target.value)} rows={2} style={{ ...inputStyle, resize: "vertical" }} />)}
        <div style={row}>
          {field("Max Duration (s)", <input type="number" value={maxDur} onChange={(e: any) => setMaxDur(Number(e.target.value))} style={inputStyle} />)}
          {field("Version", <input placeholder="v2.0" style={inputStyle} />)}
        </div>
        <div style={{ display: "flex", gap: 16, fontSize: 13, marginBottom: 16 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}><input type="checkbox" checked={allowShell} onChange={e => setAllowShell(e.target.checked)} /> Allow Shell</label>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}><input type="checkbox" checked={noFlash} onChange={e => setNoFlash(e.target.checked)} /> No Flash</label>
        </div>
        <div><Btn onClick={() => {}}>Start Validation</Btn></div>
        {status && <div style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: status.startsWith("Error") ? "var(--red)" : "var(--fg-secondary)", marginTop: 8 }}>{status}</div>}
      </form>
    </div>
  );
}
