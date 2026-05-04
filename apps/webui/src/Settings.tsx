import { useState, useEffect } from "react";
import { useT } from "./i18n";
import { Header, Btn } from "./Dashboard";

const API = "/api/config";

type ProviderType = "deepseek" | "deepseek-openai" | "anthropic" | "openai" | "mock";

interface LlmForm {
  provider: ProviderType;
  apiKeyEnv: string;
  baseUrl: string;
  plannerModel: string;
  observerModel: string;
  replyModel: string;
  plannerTimeout: number;
  observerTimeout: number;
  replyTimeout: number;
}

function parseLlmData(d: any): LlmForm {
  const pkey = d?.providers ? Object.keys(d.providers)[0] : "mock";
  const p = d?.providers?.[pkey] ?? {};
  return {
    provider: (d?.default_provider as string) ?? "mock",
    apiKeyEnv: (p.api_key_env as string) ?? "DEEPSEEK_API_KEY",
    baseUrl: (p.base_url as string) ?? "",
    plannerModel: (p.models?.planner as string) ?? "",
    observerModel: (p.models?.observer as string) ?? "",
    replyModel: (p.models?.reply as string) ?? "",
    plannerTimeout: (p.timeout?.planner as number) ?? 180,
    observerTimeout: (p.timeout?.observer as number) ?? 90,
    replyTimeout: (p.timeout?.reply as number) ?? 90,
  };
}

function buildLlmData(f: LlmForm) {
  return {
    default_provider: f.provider,
    providers: {
      [f.provider]: {
        type: f.provider,
        api_key_env: f.apiKeyEnv,
        ...(f.baseUrl ? { base_url: f.baseUrl } : {}),
        models: { planner: f.plannerModel, observer: f.observerModel, reply: f.replyModel },
        timeout: { planner: f.plannerTimeout, observer: f.observerTimeout, reply: f.replyTimeout },
      },
    },
  };
}

export function Settings({ onBack }: { onBack: () => void }) {
  const { t } = useT();
  const [tab, setTab] = useState<"llm" | "system">("llm");
  const [form, setForm] = useState<LlmForm>({ provider: "mock", apiKeyEnv: "DEEPSEEK_API_KEY", baseUrl: "", plannerModel: "", observerModel: "", replyModel: "", plannerTimeout: 180, observerTimeout: 90, replyTimeout: 90 });
  const [advanced, setAdvanced] = useState(false);
  const [rawYaml, setRawYaml] = useState("");
  const [origYaml, setOrigYaml] = useState("");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    fetch(`${API}/llm.yml`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then((d: any) => { setRawYaml(d.yaml); setForm(parseLlmData(d.data)); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function update(p: Partial<LlmForm>) { setForm(prev => ({ ...prev, ...p })); }

  async function save() {
    setMsg("Saving...");
    try {
      const body = advanced ? { yaml: rawYaml } : { data: buildLlmData(form) };
      const r = await fetch(`${API}/llm.yml`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json();
      if (r.ok) { setRawYaml(r.ok ? rawYaml : rawYaml); setMsg("✓ Saved. Restart server to apply."); }
      else { setMsg("✗ " + (d as any).error); }
    } catch (e: any) { setMsg("✗ " + e.message); }
  }

  async function testConn() {
    setTesting(true); setMsg("Testing...");
    try {
      const r = await fetch("/api/targets");
      if (r.ok) setMsg("✓ Server is running with current config");
      else setMsg("✗ Server returned error. Check config.");
    } catch { setMsg("✗ Cannot reach server. Start the HTTP Runtime first."); }
    finally { setTesting(false); }
  }

  if (loading) return <div style={{ padding: 40, color: "var(--fg-tertiary)" }}>Loading...</div>;

  const f: any = { display: "flex", flexDirection: "column", gap: 24 };
  const is = { width: "100%", background: "var(--bg-card)", border: "1px solid var(--border)", color: "var(--fg)", padding: "9px 13px", borderRadius: 6, fontFamily: "var(--font-sans)", fontSize: 14, outline: "none", boxSizing: "border-box" } as const;
  const field = (label: string, el: any, hint?: string) => (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 500, color: "var(--fg-secondary)", marginBottom: 5, textTransform: "uppercase", letterSpacing: ".5px" }}>{label}</div>
      {el}
      {hint && <div style={{ fontSize: 11, color: "var(--fg-tertiary)", marginTop: 3, fontFamily: "var(--font-mono)" }}>{hint}</div>}
    </div>
  );

  const tabBtn = (name: "llm" | "system", label: string) => (
    <button onClick={() => setTab(name)} style={{ padding: "8px 18px", border: "none", background: tab === name ? "var(--fg)" : "transparent", color: tab === name ? "var(--bg-card)" : "var(--fg-secondary)", cursor: "pointer", borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "var(--font-sans)" }}>{label}</button>
  );

  return (
    <div style={f}>
      <Header title="Settings"><Btn ghost onClick={onBack}>← Back</Btn></Header>

      <div style={{ display: "flex", gap: 8 }}>{tabBtn("llm", "LLM Provider")}{tabBtn("system", "System")}</div>

      {tab === "llm" && (
        <div style={{ maxWidth: 600 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Provider Configuration</div>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--fg-secondary)", cursor: "pointer" }}>
              <input type="checkbox" checked={advanced} onChange={e => setAdvanced(e.target.checked)} />
              Advanced (YAML)
            </label>
          </div>

          {advanced ? (
            <textarea value={rawYaml} onChange={e => setRawYaml(e.target.value)} spellCheck={false}
              style={{ ...is, minHeight: 380, fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.6, resize: "vertical" }} />
          ) : (
            <>
              {field("Provider Type",
                <select value={form.provider} onChange={e => update({ provider: e.target.value as ProviderType })} style={is}>
                  <option value="deepseek-openai">DeepSeek (OpenAI API)</option>
                  <option value="deepseek">DeepSeek (Anthropic API)</option>
                  <option value="anthropic">Anthropic (Claude)</option>
                  <option value="openai">OpenAI (GPT)</option>
                  <option value="mock">Mock (Testing)</option>
                </select>,
                "Which LLM API to use"
              )}
              {form.provider !== "mock" && <>
                {field("API Key Env Var",
                  <input value={form.apiKeyEnv} onChange={e => update({ apiKeyEnv: e.target.value })} placeholder="DEEPSEEK_API_KEY" style={is} />,
                  "Environment variable name that holds the API key"
                )}
                <div style={{ background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 6, padding: "12px 16px", marginBottom: 14, fontSize: 12, color: "var(--fg-secondary)", lineHeight: 1.6 }}>
                  The actual API key is never stored in config. Set it when starting the server:<br />
                  <code style={{ background: "var(--bg-card)", padding: "2px 6px", borderRadius: 3, fontFamily: "var(--font-mono)" }}>{form.apiKeyEnv}=sk-xxx pnpm --filter @embed-agent/http-server dev</code>
                </div>
              </>}
              {field("Base URL",
                <input value={form.baseUrl} onChange={e => update({ baseUrl: e.target.value })} placeholder={form.provider === "deepseek-openai" ? "https://api.deepseek.com" : form.provider === "deepseek" ? "https://api.deepseek.com/anthropic" : ""} style={is} />,
                "Override if using proxy/gateway"
              )}
              <div style={{ fontSize: 11, fontWeight: 500, color: "var(--fg-secondary)", marginBottom: 8, textTransform: "uppercase", letterSpacing: ".5px", marginTop: 8 }}>Models</div>
              <div style={{ display: "flex", gap: 12 }}>
                {field("Planner", <input value={form.plannerModel} onChange={e => update({ plannerModel: e.target.value })} placeholder="deepseek-v4-pro" style={is} />)}
                {field("Observer", <input value={form.observerModel} onChange={e => update({ observerModel: e.target.value })} placeholder="deepseek-v4-pro" style={is} />)}
                {field("Reply", <input value={form.replyModel} onChange={e => update({ replyModel: e.target.value })} placeholder="deepseek-v4-pro" style={is} />)}
              </div>
              <div style={{ display: "flex", gap: 12 }}>
                {field("Planner Timeout", <input type="number" value={form.plannerTimeout} onChange={e => update({ plannerTimeout: Number(e.target.value) })} style={is} />)}
                {field("Observer Timeout", <input type="number" value={form.observerTimeout} onChange={e => update({ observerTimeout: Number(e.target.value) })} style={is} />)}
                {field("Reply Timeout", <input type="number" value={form.replyTimeout} onChange={e => update({ replyTimeout: Number(e.target.value) })} style={is} />)}
              </div>
            </>
          )}

          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 16 }}>
            <Btn onClick={save}>Save</Btn>
            <button onClick={testConn} disabled={testing} style={{ background: "transparent", border: "1px solid var(--border)", color: "var(--fg-secondary)", padding: "10px 18px", borderRadius: 6, fontFamily: "var(--font-sans)", fontSize: 13, cursor: "pointer" }}>
              {testing ? "..." : "Test Connection"}
            </button>
            {msg && <span style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: msg.startsWith("✓") ? "var(--green)" : msg.startsWith("✗") ? "var(--red)" : "var(--fg-secondary)" }}>{msg}</span>}
          </div>
        </div>
      )}

      {tab === "system" && (
        <div style={{ maxWidth: 600 }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>System Configuration</div>
          <div style={{ color: "var(--fg-tertiary)", fontSize: 13, lineHeight: 1.6 }}>
            System config (runtime rules, security policies, observer settings) is edited via the YAML editor.
            <br /><br />
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
              <input type="checkbox" onChange={async (e) => {
                if (e.target.checked) {
                  try { const r = await fetch(`${API}/system.yml`); const d = await r.json(); setRawYaml(d.yaml); } catch {}
                }
              }} />
              Load system.yml for editing
            </label>
            {rawYaml && tab === "system" && (
              <>
                <textarea value={rawYaml} onChange={e => setRawYaml(e.target.value)} spellCheck={false}
                  style={{ ...is, minHeight: 400, fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.6, resize: "vertical", marginTop: 12 }} />
                <div style={{ marginTop: 12 }}>
                  <Btn onClick={async () => {
                    try { const r = await fetch(`${API}/system.yml`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ yaml: rawYaml }) }); const d = await r.json();
                      setMsg(r.ok ? "✓ Saved" : "✗ " + (d as any).error); } catch (e: any) { setMsg("✗ " + e.message); }
                  }}>Save System Config</Btn>
                  {msg && <span style={{ marginLeft: 12, fontSize: 12, fontFamily: "var(--font-mono)", color: msg.startsWith("✓") ? "var(--green)" : "var(--red)" }}>{msg}</span>}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
