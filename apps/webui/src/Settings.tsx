import { useState, useEffect } from "react";
import { useT } from "./i18n";
import { PageHeader, Btn, Field, inputStyle, TabBtn } from "./shared";
import { api } from "./api";

const API = import.meta.env.DEV ? "/api/config" : "/config";

type ProviderType = "deepseek" | "deepseek-openai" | "anthropic" | "openai" | "mock";

interface LlmForm {
  provider: ProviderType;
  apiKey: string;
  apiKeyConfigured: boolean;
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
  const pkey = (d?.providers ? Object.keys(d.providers)[0] : "mock") ?? "mock";
  const p = d?.providers?.[pkey] ?? {};
  const provider = ((d?.default_provider as string) ?? "mock") as ProviderType;
  return {
    provider,
    apiKey: "",
    apiKeyConfigured: Boolean(p.api_key),
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
        ...(f.apiKey ? { api_key: f.apiKey } : {}),
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
  const [form, setForm] = useState<LlmForm>({ provider: "mock", apiKey: "", apiKeyConfigured: false, apiKeyEnv: "DEEPSEEK_API_KEY", baseUrl: "", plannerModel: "", observerModel: "", replyModel: "", plannerTimeout: 180, observerTimeout: 90, replyTimeout: 90 });
  const [advanced, setAdvanced] = useState(false);
  const [rawYaml, setRawYaml] = useState("");
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
    setMsg(t("settings.saving"));
    try {
      const body = advanced ? { yaml: rawYaml } : { data: buildLlmData(form) };
      const r = await fetch(`${API}/llm.yml`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json();
      if (r.ok) {
        setMsg(t("settings.saved"));
        if (!advanced && form.apiKey) update({ apiKey: "", apiKeyConfigured: true });
      } else { setMsg(t("settings.error") + ": " + (d as any).error); }
    } catch (e: any) { setMsg(t("settings.error") + ": " + e.message); }
  }

  async function testConn() {
    setTesting(true); setMsg(t("settings.testing"));
    try {
      const r = await api.testLlmConfig();
      setMsg((r.status === "ok" ? t("settings.testOk") : t("settings.testFail")) + ": " + r.message);
    } catch { setMsg(t("settings.testFail")); }
    finally { setTesting(false); }
  }

  if (loading) return <div style={{ padding: 40, color: "var(--fg-tertiary)", fontSize: 13, fontFamily: "var(--font-mono)" }}>{t("monitor.loading")}</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, animation: "fadeIn .2s ease both" }}>
      <PageHeader title={t("settings.title")} onBack={onBack} />

      <div style={{ display: "flex", gap: 8 }}>
        <TabBtn active={tab === "llm"} onClick={() => setTab("llm")}>{t("settings.llm")}</TabBtn>
        <TabBtn active={tab === "system"} onClick={() => setTab("system")}>{t("settings.system")}</TabBtn>
      </div>

      {tab === "llm" && (
        <div style={{ maxWidth: 620 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{t("settings.providerConfig")}</div>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--fg-secondary)", cursor: "pointer" }}>
              <input type="checkbox" checked={advanced} onChange={e => setAdvanced(e.target.checked)} />
              {t("settings.advanced")}
            </label>
          </div>

          {advanced ? (
            <textarea value={rawYaml} onChange={e => setRawYaml(e.target.value)} spellCheck={false}
              style={{ ...inputStyle, minHeight: 380, fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.6, resize: "vertical" }} />
          ) : (
            <>
              {Field({ label: t("settings.providerType"), children:
                <select value={form.provider} onChange={e => update({ provider: e.target.value as ProviderType })} style={inputStyle}>
                  <option value="deepseek-openai">DeepSeek (OpenAI API)</option>
                  <option value="deepseek">DeepSeek (Anthropic API)</option>
                  <option value="anthropic">Anthropic (Claude)</option>
                  <option value="openai">OpenAI (GPT)</option>
                  <option value="mock">Mock</option>
                </select>,
                hint: t("settings.providerHint"),
              })}
              {form.provider !== "mock" && Field({ label: t("settings.apiKey"), children:
                <input type="password" value={form.apiKey} onChange={e => update({ apiKey: e.target.value, apiKeyConfigured: e.target.value ? false : form.apiKeyConfigured })} placeholder={form.apiKeyConfigured ? "•••••• configured" : "sk-..."} style={inputStyle} />,
                hint: form.apiKeyConfigured ? t("settings.apiKeyConfigured") : t("settings.apiKeyHint"),
              })}
              {Field({ label: t("settings.baseUrl"), children:
                <input value={form.baseUrl} onChange={e => update({ baseUrl: e.target.value })} placeholder="https://api.deepseek.com" style={inputStyle} />,
                hint: t("settings.baseUrlHint"),
              })}
              <div style={{ fontSize: 10, fontWeight: 600, color: "var(--fg-secondary)", marginBottom: 8, textTransform: "uppercase", letterSpacing: ".5px", marginTop: 8 }}>
                {t("settings.models")}
              </div>
              <div style={{ display: "flex", gap: 12 }}>
                {Field({ label: t("settings.modelPlanning"), children: <input value={form.plannerModel} onChange={e => update({ plannerModel: e.target.value })} placeholder="deepseek-v4-pro" style={inputStyle} /> })}
                {Field({ label: t("settings.modelMonitoring"), children: <input value={form.observerModel} onChange={e => update({ observerModel: e.target.value })} placeholder="deepseek-v4-pro" style={inputStyle} /> })}
                {Field({ label: t("settings.modelSummary"), children: <input value={form.replyModel} onChange={e => update({ replyModel: e.target.value })} placeholder="deepseek-v4-pro" style={inputStyle} /> })}
              </div>
              <div style={{ display: "flex", gap: 12 }}>
                {Field({ label: t("settings.plannerTimeout"), children: <input type="number" value={form.plannerTimeout} onChange={e => update({ plannerTimeout: Number(e.target.value) })} style={inputStyle} /> })}
                {Field({ label: t("settings.observerTimeout"), children: <input type="number" value={form.observerTimeout} onChange={e => update({ observerTimeout: Number(e.target.value) })} style={inputStyle} /> })}
                {Field({ label: t("settings.replyTimeout"), children: <input type="number" value={form.replyTimeout} onChange={e => update({ replyTimeout: Number(e.target.value) })} style={inputStyle} /> })}
              </div>
            </>
          )}

          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 16 }}>
            <Btn onClick={save}>{t("settings.save")}</Btn>
            <button onClick={testConn} disabled={testing} style={{
              background: "transparent", border: "1px solid var(--border)", color: "var(--fg-secondary)",
              padding: "8px 18px", borderRadius: 4, fontFamily: "var(--font-sans)", fontSize: 12,
              cursor: "pointer", transition: "all .12s",
            }}
            onMouseEnter={e => { e.currentTarget.style.color = "var(--fg)"; e.currentTarget.style.borderColor = "var(--fg-tertiary)"; }}
            onMouseLeave={e => { e.currentTarget.style.color = "var(--fg-secondary)"; e.currentTarget.style.borderColor = "var(--border)"; }}
            >
              {testing ? "..." : t("settings.testConn")}
            </button>
            {msg && (
              <span style={{
                fontSize: 11, fontFamily: "var(--font-mono)",
                color: msg.startsWith(t("settings.saved")) || msg.startsWith(t("settings.testOk")) ? "var(--green)" : msg.includes(t("settings.error")) || msg.startsWith(t("settings.testFail")) ? "var(--red)" : "var(--fg-secondary)",
              }}>{msg}</span>
            )}
          </div>
        </div>
      )}

      {tab === "system" && (
        <div style={{ maxWidth: 620 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>{t("settings.systemConfig")}</div>
          <SystemEditor msg={msg} setMsg={setMsg} />
        </div>
      )}
    </div>
  );
}

function SystemEditor({ msg: _msg, setMsg }: { msg: string; setMsg: (s: string) => void }) {
  const { t } = useT();
  const [yaml, setYaml] = useState("");
  const [loaded, setLoaded] = useState(false);

  async function load() {
    try {
      const r = await fetch(`${API}/system.yml`);
      const d = await r.json();
      setYaml(d.yaml);
      setLoaded(true);
    } catch { /* ignore */ }
  }

  if (!loaded) return <Btn onClick={load}>{t("settings.loadSystem")}</Btn>;

  return (
    <>
      <textarea value={yaml} onChange={e => setYaml(e.target.value)} spellCheck={false}
        style={{ ...inputStyle, minHeight: 400, fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.6, resize: "vertical", padding: 14 }} />
      <div style={{ marginTop: 12 }}>
        <Btn onClick={async () => {
          try {
            const r = await fetch(`${API}/system.yml`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ yaml }) });
            const d = await r.json();
            setMsg(r.ok ? t("settings.saved") : t("settings.error") + ": " + (d as any).error);
          } catch (e: any) {
            setMsg(t("settings.error") + ": " + e.message);
          }
        }}>{t("settings.saveSystem")}</Btn>
      </div>
    </>
  );
}
