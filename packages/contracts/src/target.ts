// Target 运行时状态
export type TargetState =
  | "idle"
  | "preparing"
  | "busy"
  | "cleaning"
  | "dirty"
  | "recovery"
  | "offline";

// 连接子状态
export type SerialState = "connected" | "disconnected";
export type AdbState = "online" | "offline" | "disconnected";
export type FastbootState = "connected" | "disconnected";

// Connection 配置
export interface ConnectionConfig {
  serial?: { port: string; baud: number };
  adb?: { device_id: string };
  fastboot?: { device_id: string };
  ssh?: { host: string; port: number };
}

// Target Profile (静态配置, YAML)
export interface TargetProfile {
  target_id: string;
  display_name?: string;
  connections: ConnectionConfig;
  flash?: {
    method: "fastboot" | "custom_command";
    artifact_type: string;
    command?: string; // custom_command 时
  };
  recovery?: {
    reboot_method?: "adb" | "fastboot" | "custom_command";
    stable_artifact?: string;
  };
  safety: {
    allow_flash: boolean;
    allow_reboot: boolean;
    allow_shell_exec: boolean;
    allow_power_cycle: boolean;
  };
  target_hints?: {
    boot_markers?: string[];
    boot_sequence?: { stage: string; expected_duration: number }[];
    fail_patterns?: string[];
    known_quirks?: string[];
    recommended_checks?: string[];
  };
  skills?: string[];
}

// Target 运行时状态 (持久化)
export interface TargetRuntimeState {
  target_id: string;
  state: TargetState;
  current_run_id?: string;
  serial: SerialState;
  adb: AdbState;
  fastboot: FastbootState;
  last_heartbeat_at?: string;
  updated_at: string;
}

// Target Capability
export interface Capability {
  name: string;
  description?: string;
  risk: "low" | "medium" | "high";
  available: boolean;
  requires?: { connection?: string };
  limits?: {
    default_timeout_sec?: number;
    max_duration_sec?: number;
  };
}

// Pre-flight 结果
export interface PreflightResult {
  all_passed: boolean;
  checks: { check: string; passed: boolean; error?: string }[];
  failure_type?: "host" | "device";
}
