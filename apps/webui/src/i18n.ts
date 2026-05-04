import { createContext, useContext, useState, createElement, type ReactNode } from "react";

export type Lang = "zh" | "en";

const dict: Record<Lang, Record<string, string>> = {
  zh: {
    "app.title": "Embed Agent",
    "nav.dashboard": "设备",
    "nav.start": "新建",
    "nav.history": "历史",
    "dash.online": "在线",
    "dash.running": "运行中",
    "dash.passed": "已通过",
    "dash.failed": "已失败",
    "dash.devices": "设备",
    "dash.recentRuns": "最近运行",
    "dash.noRuns": "暂无运行记录",
    "dash.total": "共 {n} 台",
    "dash.active": "{n} 个活跃",
    "dash.needsAttention": "需要关注",
    "run.table.run": "Run",
    "run.table.target": "目标",
    "run.table.state": "状态",
    "run.table.time": "耗时",
    "run.table.summary": "摘要",
    "run.running": "运行中",
    "run.completed": "已完成",
    "run.failed": "失败",
    "run.cancelled": "已取消",
    "run.pass": "通过",
    "start.title": "新建验证",
    "start.target": "目标设备",
    "start.type": "工件类型",
    "start.artifact": "工件路径",
    "start.expected": "预期结果",
    "start.maxDuration": "最大时长 (秒)",
    "start.version": "版本号",
    "start.allowShell": "允许 Shell",
    "start.noFlash": "禁止烧录",
    "start.submit": "开始验证",
    "start.starting": "启动中...",
    "start.selectTarget": "选择设备...",
    "detail.timeline": "步骤时间线",
    "detail.observer": "Observer 决策",
    "detail.serialOutput": "串口输出",
    "detail.criteria": "标准评估",
    "detail.keyEvidence": "关键证据",
    "detail.allEvents": "全部事件",
    "detail.noSteps": "暂无步骤",
    "detail.loading": "加载中...",
    "detail.pause": "暂停",
    "detail.resume": "继续",
    "detail.cancel": "取消",
    "detail.back": "返回",
    "history.title": "运行历史",
    "history.empty": "暂无运行记录。启动 HTTP Runtime 并创建验证任务。",
    "badge.pass": "通过",
    "badge.fail": "失败",
    "badge.running": "运行中",
    "conn.serial": "串口",
    "conn.adb": "ADB",
    "conn.fastboot": "FB",
    "lang.switch": "EN",
  },
  en: {
    "app.title": "Embed Agent",
    "nav.dashboard": "Devices",
    "nav.start": "New",
    "nav.history": "History",
    "dash.online": "Online",
    "dash.running": "Running",
    "dash.passed": "Passed",
    "dash.failed": "Failed",
    "dash.devices": "Devices",
    "dash.recentRuns": "Recent Runs",
    "dash.noRuns": "No active runs",
    "dash.total": "{n} total",
    "dash.active": "{n} active",
    "dash.needsAttention": "Needs attention",
    "run.table.run": "Run",
    "run.table.target": "Target",
    "run.table.state": "State",
    "run.table.time": "Time",
    "run.table.summary": "Summary",
    "run.running": "Running",
    "run.completed": "Completed",
    "run.failed": "Failed",
    "run.cancelled": "Cancelled",
    "run.pass": "Pass",
    "start.title": "New Validation",
    "start.target": "Target Device",
    "start.type": "Artifact Type",
    "start.artifact": "Artifact Path",
    "start.expected": "Expected Outcome",
    "start.maxDuration": "Max Duration (s)",
    "start.version": "Version",
    "start.allowShell": "Allow Shell",
    "start.noFlash": "No Flash",
    "start.submit": "Start Validation",
    "start.starting": "Starting...",
    "start.selectTarget": "Select device...",
    "detail.timeline": "Timeline",
    "detail.observer": "Observer Decisions",
    "detail.serialOutput": "Serial Output",
    "detail.criteria": "Criteria Evaluation",
    "detail.keyEvidence": "Key Evidence",
    "detail.allEvents": "All Events",
    "detail.noSteps": "No steps yet",
    "detail.loading": "Loading...",
    "detail.pause": "Pause",
    "detail.resume": "Resume",
    "detail.cancel": "Cancel",
    "detail.back": "Back",
    "history.title": "Run History",
    "history.empty": "No runs found. Start the HTTP Runtime and create a run.",
    "badge.pass": "PASS",
    "badge.fail": "FAIL",
    "badge.running": "RUNNING",
    "conn.serial": "SERIAL",
    "conn.adb": "ADB",
    "conn.fastboot": "FB",
    "lang.switch": "中",
  },
};

const I18nCtx = createContext<{ lang: Lang; t: (key: string, vars?: Record<string, string | number>) => string; toggle: () => void }>(null!);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>("zh");

  function t(key: string, vars?: Record<string, string | number>): string {
    let s = dict[lang][key] ?? dict["en"][key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
    return s;
  }

  function toggle() { setLang(l => l === "zh" ? "en" : "zh"); }

  return createElement(I18nCtx.Provider, { value: { lang, t, toggle } }, children);
}

export function useT() {
  return useContext(I18nCtx);
}
