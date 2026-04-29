export interface ExecResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

export interface Connection {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  state(): "connected" | "disconnected" | "error";
  exec?(cmd: string, timeout: number): Promise<ExecResult>;
  stream?(timeout: number): AsyncIterable<string>;
  push?(src: string, dst: string): Promise<void>;
  flash?(image: string, partition: string): Promise<void>;
  onDisconnect?: () => void;  // Set by CM: conn.onDisconnect = () => {...}
}
