use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Clean Windows UNC path prefix (\\?\) for Node.js compatibility
fn clean_path_for_nodejs(path: &Path) -> String {
    let path_str = path.display().to_string();
    // Remove Windows UNC prefix \\?\ if present
    #[cfg(target_os = "windows")]
    {
        if path_str.starts_with("\\\\?\\") {
            path_str[4..].replace('\\', "/")
        } else {
            path_str.replace('\\', "/")
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        path_str
    }
}

use tauri::path::BaseDirectory;
use tauri::{App, AppHandle, Emitter, Manager, RunEvent};

const SERVER_HOST: &str = "127.0.0.1";
const WINDOW_LABEL: &str = "main";
const NODE_SIDECAR_NAME: &str = "embed-agent-node";

type SharedChild = Arc<Mutex<Option<Child>>>;

/// Server process status
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum ServerStatus {
    Starting,
    Healthy,
    Unhealthy,
    Crashed,
    Restarting,
    Stopped,
    Failed,
}

/// Restart policy configuration
#[derive(Debug, Clone)]
pub struct RestartPolicy {
    pub max_retries: u32,
    pub backoff_intervals: Vec<Duration>,
    pub health_check_interval: Duration,
    pub consecutive_failures_threshold: u32,
}

impl Default for RestartPolicy {
    fn default() -> Self {
        Self {
            max_retries: 5,
            backoff_intervals: vec![
                Duration::from_secs(2),
                Duration::from_secs(5),
                Duration::from_secs(10),
                Duration::from_secs(30),
                Duration::from_secs(60),
            ],
            health_check_interval: Duration::from_secs(5),
            consecutive_failures_threshold: 3,
        }
    }
}

/// Monitoring state
#[derive(Clone)]
pub struct MonitorState {
    pub status: ServerStatus,
    pub retry_count: u32,
    pub last_healthy: Option<Instant>,
    pub consecutive_failures: u32,
    pub error_message: Option<String>,
}

impl Default for MonitorState {
    fn default() -> Self {
        Self {
            status: ServerStatus::Starting,
            retry_count: 0,
            last_healthy: None,
            consecutive_failures: 0,
            error_message: None,
        }
    }
}

/// Server configuration needed for restarts
#[derive(Clone)]
pub struct ServerConfig {
    pub port: u16,
    pub server_url: String,
    pub runtime_root: PathBuf,
    pub data_dir: PathBuf,
}

#[derive(Clone, serde::Serialize)]
struct DesktopStatusPayload {
    status: &'static str,
    message: String,
}

#[derive(Clone, serde::Serialize)]
struct ServerStatusPayload {
    status: &'static str,
    message: String,
    retry_count: u32,
    max_retries: u32,
    last_healthy_ago: Option<u64>,
}

#[derive(Clone)]
struct DesktopState {
    server_child: SharedChild,
    monitor_state: Arc<RwLock<MonitorState>>,
    server_config: Arc<RwLock<Option<ServerConfig>>>,
    restart_policy: Arc<RestartPolicy>,
    shutdown_flag: Arc<AtomicBool>,
    monitor_handle: Arc<Mutex<Option<JoinHandle<()>>>>,
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let server_child = Arc::new(Mutex::new(None));

            let starting_message = "Preparing local runtime".to_string();
            emit_status(app.handle(), "starting", starting_message.clone());
            let _ = show_startup_window(app.handle(), "starting", &starting_message);

            match initialize_runtime(app, Arc::clone(&server_child)) {
                Ok(init_result) => {
                    // Create server config for restarts
                    let config = ServerConfig {
                        port: init_result.port,
                        server_url: init_result.server_url.clone(),
                        runtime_root: init_result.runtime_root.clone(),
                        data_dir: init_result.data_dir.clone(),
                    };

                    // Create desktop state with monitoring
                    let state = Arc::new(DesktopState {
                        server_child: Arc::clone(&server_child),
                        monitor_state: Arc::new(RwLock::new(MonitorState {
                            status: ServerStatus::Healthy,
                            retry_count: 0,
                            last_healthy: Some(Instant::now()),
                            consecutive_failures: 0,
                            error_message: None,
                        })),
                        server_config: Arc::new(RwLock::new(Some(config))),
                        restart_policy: Arc::new(RestartPolicy::default()),
                        shutdown_flag: Arc::new(AtomicBool::new(false)),
                        monitor_handle: Arc::new(Mutex::new(None)),
                    });

                    // Store config for monitoring
                    {
                        let mut monitor = state.monitor_state.write().unwrap();
                        monitor.status = ServerStatus::Healthy;
                        monitor.last_healthy = Some(Instant::now());
                    }

                    // Start monitor thread
                    let state_clone = Arc::clone(&state);
                    let app_handle = app.handle().clone();
                    start_monitor_thread(app_handle, state_clone);

                    // Manage state
                    app.manage(state);

                    if let Err(error) = show_main_window(app.handle(), &init_result.server_url) {
                        let message = format!(
                            "Local runtime started, but the desktop window could not open: {}",
                            error
                        );
                        emit_status(app.handle(), "error", message.clone());
                        let _ = show_startup_window(app.handle(), "error", &message);
                    } else {
                        emit_status(
                            app.handle(),
                            "ready",
                            "Desktop runtime is ready".to_string(),
                        );
                    }
                }
                Err(message) => {
                    emit_status(app.handle(), "error", message.clone());
                    let _ = show_startup_window(app.handle(), "error", &message);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_server_status,
            restart_server,
            stop_server_cmd,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build desktop shell")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app.try_state::<DesktopState>() {
                    shutdown_monitoring(&state);
                }
                stop_server(app);
            }
        });
}

struct InitResult {
    server_url: String,
    runtime_root: PathBuf,
    data_dir: PathBuf,
    port: u16,
}

fn initialize_runtime(app: &App, server_child: SharedChild) -> Result<InitResult, String> {
    let runtime_root = prepare_runtime_root(app).map_err(describe_tauri_error)?;
    let data_dir = prepare_data_dir(app).map_err(describe_tauri_error)?;
    ensure_default_config(&data_dir).map_err(describe_tauri_error)?;
    let server_url =
        start_runtime_server(app, &runtime_root, &data_dir, server_child).map_err(describe_tauri_error)?;

    // Extract port from server_url
    let port = server_url
        .rsplit(':')
        .next()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(0);

    Ok(InitResult {
        server_url,
        runtime_root,
        data_dir,
        port,
    })
}

fn prepare_runtime_root(app: &App) -> tauri::Result<PathBuf> {
    let resource_dir = app
        .path()
        .resolve("desktop-runtime/server", BaseDirectory::Resource)?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| tauri::Error::Anyhow(anyhow::anyhow!("failed to locate desktop-runtime parent")))?;
    if !resource_dir.exists() {
        return Err(tauri::Error::AssetNotFound(
            resource_dir.display().to_string(),
        ));
    }
    Ok(resource_dir)
}

fn prepare_data_dir(_app: &App) -> tauri::Result<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let local_app_data = std::env::var("LOCALAPPDATA")
            .map_err(|e| tauri::Error::Anyhow(anyhow::anyhow!("LOCALAPPDATA not set: {}", e)))?;
        let dir = PathBuf::from(local_app_data).join("EmbedAgent").join("data");
        std::fs::create_dir_all(&dir).map_err(|e| tauri::Error::Anyhow(e.into()))?;
        Ok(dir)
    }

    #[cfg(target_os = "macos")]
    {
        let home = dirs::home_dir()
            .ok_or_else(|| tauri::Error::Anyhow(anyhow::anyhow!("home directory not found")))?;
        let dir = home.join("Library").join("Application Support").join("EmbedAgent").join("data");
        std::fs::create_dir_all(&dir).map_err(|e| tauri::Error::Anyhow(e.into()))?;
        Ok(dir)
    }

    #[cfg(target_os = "linux")]
    {
        let home = dirs::home_dir()
            .ok_or_else(|| tauri::Error::Anyhow(anyhow::anyhow!("home directory not found")))?;
        let dir = home.join(".local").join("share").join("embed-agent").join("data");
        std::fs::create_dir_all(&dir).map_err(|e| tauri::Error::Anyhow(e.into()))?;
        Ok(dir)
    }
}

fn ensure_default_config(data_dir: &Path) -> tauri::Result<()> {
    std::fs::create_dir_all(data_dir).map_err(|e| tauri::Error::Anyhow(e.into()))?;

    let system_path = data_dir.join("system.yml");
    if !system_path.exists() {
        std::fs::write(
      &system_path,
      format!(
        "runtime:\n  retry:\n    max_retries: 3\n    intervals_sec: [2, 5, 10]\n    retryable: [\"timeout\", \"connection_lost\"]\n  rule_policy:\n    fatal_patterns: [\"Kernel panic\", \"Watchdog reset\"]\n    warning_patterns: [\"error\", \"FAILED\"]\n    silence_timeout_sec: 60\n  ring_buffer:\n    max_lines: 500\n    default_before: 200\n    default_after: 80\n  step_executor:\n    max_timeout_sec: 3600\n    default_timeout_sec: 60\nstorage:\n  data_root: {}\n  max_evidence_bytes: 104857600\n  cleanup:\n    keep_completed_days: 30\n    keep_failed_days: 90\n    max_episodes_per_target: 100\nnotifications:\n  enabled: false\nsecurity:\n  allowed_shell_commands: [\"echo\", \"uname\", \"dmesg\", \"cat\", \"true\", \"false\"]\n  max_command_length: 4096\n  block_unsafe_patterns: true\nobserver:\n  debounce_sec: 30\n  max_concurrent_per_run: 1\n  default_checkpoint_interval_sec: 300\n  circuit_breaker:\n    max_failures: 3\n    probe_after_sec: 300\n  warning_escalation:\n    threshold: 5\n    window_sec: 300\nprompt_version: \"1\"\n",
        serde_json::to_string(&data_dir.display().to_string().replace('\\', "/")).unwrap_or_else(|_| "\".embed-agent\"".to_string())
      ),
    )
    .map_err(|e| tauri::Error::Anyhow(e.into()))?;
    }

    let llm_path = data_dir.join("llm.yml");
    if !llm_path.exists() {
        std::fs::write(
      &llm_path,
      "default_provider: mock\nproviders:\n  mock:\n    type: mock\n    api_key_env: EMBED_AGENT_UNUSED\n    models:\n      planner: mock\n      observer: mock\n      reply: mock\n    timeout:\n      planner: 120\n      observer: 60\n      reply: 60\n",
    )
    .map_err(|e| tauri::Error::Anyhow(e.into()))?;
    }

    let targets_path = data_dir.join("targets.yml");
    if !targets_path.exists() {
        std::fs::write(&targets_path, "[]\n").map_err(|e| tauri::Error::Anyhow(e.into()))?;
    }
    Ok(())
}

fn start_runtime_server(
    app: &App,
    runtime_root: &Path,
    data_dir: &Path,
    server_child: SharedChild,
) -> tauri::Result<String> {
    let server_port = reserve_server_port()?;
    let server_url = build_server_url(server_port);
    let logs_dir = data_dir.join("logs");
    std::fs::create_dir_all(&logs_dir).map_err(|e| tauri::Error::Anyhow(e.into()))?;

    if health_ok(server_port) {
        return Ok(server_url);
    }

    let node_path = sidecar_binary_path(app)?;
    let server_entry = runtime_root.join("server/dist/main.js");
    let web_dist = runtime_root.join("webui");
    let runtime_lib_dir = runtime_root.join("lib");

    if !node_path.exists() {
        return Err(tauri::Error::AssetNotFound(node_path.display().to_string()));
    }
    if !server_entry.exists() {
        return Err(tauri::Error::AssetNotFound(
            server_entry.display().to_string(),
        ));
    }

    let stdout = std::fs::File::create(logs_dir.join("desktop-http-server.out.log"))
        .map_err(|e| tauri::Error::Anyhow(e.into()))?;
    let stderr = std::fs::File::create(logs_dir.join("desktop-http-server.err.log"))
        .map_err(|e| tauri::Error::Anyhow(e.into()))?;

    let mut command = Command::new(&node_path);
    command
        .arg(clean_path_for_nodejs(&server_entry))
        .current_dir(runtime_root)
        .env("HOST", SERVER_HOST)
        .env("PORT", server_port.to_string())
        .env("EMBED_AGENT_DATA", clean_path_for_nodejs(data_dir))
        .env("EMBED_AGENT_SERVER_URL", &server_url)
        .env("EMBED_AGENT_WEB_DIST", clean_path_for_nodejs(&web_dist))
        .env("EMBED_AGENT_DESKTOP", "1")
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));

    if runtime_lib_dir.exists() {
        command.env("DYLD_LIBRARY_PATH", &runtime_lib_dir);
    }

    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let child = command
        .spawn()
        .map_err(|e| tauri::Error::Anyhow(e.into()))?;
    {
        let mut slot = server_child
            .lock()
            .map_err(|_| tauri::Error::Anyhow(anyhow::anyhow!("failed to lock server child")))?;
        *slot = Some(child);
    }

    let deadline = Duration::from_secs(20);
    match wait_for_health(server_port, deadline) {
        Ok(()) => Ok(server_url),
        Err(message) => {
            stop_server(app.handle());
            emit_status(app.handle(), "error", message.clone());
            Err(tauri::Error::Anyhow(anyhow::anyhow!(message)))
        }
    }
}

fn sidecar_binary_path(app: &App) -> tauri::Result<PathBuf> {
    let target_triple = tauri::utils::platform::target_triple()
        .map_err(|e| tauri::Error::Anyhow(anyhow::anyhow!(e.to_string())))?;
    let resource_with_triple = app.path().resolve(
        format!("{NODE_SIDECAR_NAME}-{target_triple}"),
        BaseDirectory::Resource,
    )?;
    let resource_plain = app
        .path()
        .resolve(NODE_SIDECAR_NAME, BaseDirectory::Resource)?;
    let exe_dir = std::env::current_exe()
        .map_err(|e| tauri::Error::Anyhow(e.into()))?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| tauri::Error::Anyhow(anyhow::anyhow!("failed to locate executable dir")))?;
    let local_plain = exe_dir.join(NODE_SIDECAR_NAME);
    let local_with_triple = exe_dir.join(format!("{NODE_SIDECAR_NAME}-{target_triple}"));

    for candidate in [
        with_platform_extension(&resource_with_triple),
        with_platform_extension(&resource_plain),
        with_platform_extension(&local_with_triple),
        with_platform_extension(&local_plain),
    ] {
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(tauri::Error::AssetNotFound(
        with_platform_extension(&resource_with_triple)
            .display()
            .to_string(),
    ))
}

fn wait_for_health(port: u16, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if health_ok(port) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err("Runtime server did not become healthy within 20 seconds".to_string())
}

fn health_ok(port: u16) -> bool {
    let mut stream = match std::net::TcpStream::connect((SERVER_HOST, port)) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    if stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .is_err()
    {
        return false;
    }
    if stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .is_err()
    {
        return false;
    }

    let request =
        format!("GET /health HTTP/1.1\r\nHost: {SERVER_HOST}:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }
    response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")
}

fn show_main_window(app: &AppHandle, server_url: &str) -> tauri::Result<()> {
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or_else(|| tauri::Error::AssetNotFound(WINDOW_LABEL.to_string()))?;
    let url = format!("{server_url}/#/start");
    let target_url: url::Url = url
        .parse()
        .map_err(|e: url::ParseError| tauri::Error::Anyhow(anyhow::anyhow!(e.to_string())))?;
    window.navigate(target_url)?;
    window.unminimize()?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

fn show_startup_window(app: &AppHandle, status: &str, message: &str) -> tauri::Result<()> {
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or_else(|| tauri::Error::AssetNotFound(WINDOW_LABEL.to_string()))?;
    window.unminimize()?;
    window.show()?;
    window.set_focus()?;
    let script = format!(
        "window.__EMBED_AGENT_BOOTSTRAP__ = {{ status: {}, message: {} }};",
        serde_json::to_string(status).map_err(|e| tauri::Error::Anyhow(e.into()))?,
        serde_json::to_string(message).map_err(|e| tauri::Error::Anyhow(e.into()))?
    );
    window.eval(script)?;
    Ok(())
}

fn reserve_server_port() -> tauri::Result<u16> {
    let listener =
        TcpListener::bind((SERVER_HOST, 0)).map_err(|e| tauri::Error::Anyhow(e.into()))?;
    let port = listener
        .local_addr()
        .map_err(|e| tauri::Error::Anyhow(e.into()))?
        .port();
    drop(listener);
    Ok(port)
}

fn build_server_url(port: u16) -> String {
    format!("http://{SERVER_HOST}:{port}")
}

fn with_platform_extension(path: &Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        path.with_extension("exe")
    } else {
        path.to_path_buf()
    }
}

fn describe_tauri_error(error: tauri::Error) -> String {
    match error {
        tauri::Error::AssetNotFound(message) => format!("Desktop runtime asset missing: {message}"),
        other => other.to_string(),
    }
}

fn emit_status(app: &AppHandle, status: &'static str, message: String) {
    let _ = app.emit(
        "desktop-status",
        DesktopStatusPayload {
            status,
            message: message.clone(),
        },
    );
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let script = format!(
            "window.__EMBED_AGENT_SET_STATUS__?.({}, {});",
            serde_json::to_string(status).unwrap_or_else(|_| "\"error\"".to_string()),
            serde_json::to_string(&message)
                .unwrap_or_else(|_| "\"Unknown desktop error\"".to_string())
        );
        let _ = window.eval(script);
    }
}

fn stop_server(app: &AppHandle) {
    if let Some(state) = app.try_state::<DesktopState>() {
        stop_server_internal(&state.server_child);
    }
}

fn stop_server_internal(child: &SharedChild) {
    if let Ok(mut slot) = child.lock() {
        if let Some(mut c) = slot.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

/// Check if process is still alive
fn is_process_alive(child: &SharedChild) -> bool {
    if let Ok(mut guard) = child.lock() {
        if let Some(c) = guard.as_mut() {
            match c.try_wait() {
                Ok(None) => return true,
                Ok(Some(_)) | Err(_) => return false,
            }
        }
    }
    false
}

/// Start the monitoring thread
fn start_monitor_thread(app: AppHandle, state: Arc<DesktopState>) {
    let shutdown_flag = Arc::clone(&state.shutdown_flag);
    let check_interval = state.restart_policy.health_check_interval;
    let monitor_handle = Arc::clone(&state.monitor_handle);

    let handle = thread::spawn(move || {
        while !shutdown_flag.load(Ordering::Relaxed) {
            thread::sleep(check_interval);

            if shutdown_flag.load(Ordering::Relaxed) {
                break;
            }

            if let Err(e) = perform_health_check(&app, &state) {
                eprintln!("[monitor] Health check error: {}", e);
            }
        }
    });

    if let Ok(mut guard) = monitor_handle.lock() {
        *guard = Some(handle);
    };
}

/// Perform health check and handle failures
fn perform_health_check(app: &AppHandle, state: &DesktopState) -> Result<(), String> {
    let config = {
        let guard = state
            .server_config
            .read()
            .map_err(|_| "Failed to read server config".to_string())?;
        guard.clone().ok_or("Server config not initialized".to_string())?
    };

    let process_alive = is_process_alive(&state.server_child);

    let (new_status, needs_restart) = {
        let mut monitor = state
            .monitor_state
            .write()
            .map_err(|_| "Failed to lock monitor state".to_string())?;

        if !process_alive {
            monitor.consecutive_failures += 1;

            if monitor.retry_count < state.restart_policy.max_retries {
                emit_status(
                    app,
                    "crashed",
                    format!(
                        "Process died. Restarting (attempt {}/{})",
                        monitor.retry_count + 1,
                        state.restart_policy.max_retries
                    ),
                );
                (ServerStatus::Crashed, true)
            } else {
                emit_status(app, "failed", "Process died and max retries exceeded".to_string());
                monitor.status = ServerStatus::Failed;
                monitor.error_message = Some("Max retries exceeded".to_string());
                return Ok(());
            }
        } else {
            let healthy = health_ok(config.port);

            if healthy {
                monitor.last_healthy = Some(Instant::now());
                monitor.consecutive_failures = 0;
                monitor.error_message = None;

                if monitor.status == ServerStatus::Restarting {
                    monitor.retry_count = 0;
                    emit_status(app, "healthy", "Server restarted successfully".to_string());
                }

                monitor.status = ServerStatus::Healthy;
                return Ok(());
            } else {
                monitor.consecutive_failures += 1;

                if monitor.consecutive_failures >= state.restart_policy.consecutive_failures_threshold {
                    emit_status(app, "unhealthy", "Health checks failing".to_string());
                    monitor.status = ServerStatus::Unhealthy;
                }
                return Ok(());
            }
        }
    };

    {
        let mut monitor = state
            .monitor_state
            .write()
            .map_err(|_| "Failed to lock monitor state".to_string())?;
        monitor.status = new_status;
    }

    if needs_restart {
        attempt_restart(app, state)?;
    }

    Ok(())
}

/// Attempt to restart the server with backoff
fn attempt_restart(app: &AppHandle, state: &DesktopState) -> Result<(), String> {
    let config = {
        let guard = state
            .server_config
            .read()
            .map_err(|_| "Failed to read server config")?;
        guard.clone().ok_or("Server config not initialized")?
    };

    let (retry_count, backoff_duration) = {
        let mut monitor = state
            .monitor_state
            .write()
            .map_err(|_| "Failed to lock monitor state")?;

        let count = monitor.retry_count;
        monitor.retry_count += 1;
        monitor.status = ServerStatus::Restarting;

        let backoff = state
            .restart_policy
            .backoff_intervals
            .get(count as usize)
            .copied()
            .unwrap_or(Duration::from_secs(60));

        (count, backoff)
    };

    emit_status(
        app,
        "restarting",
        format!(
            "Restarting in {}s (attempt {})",
            backoff_duration.as_secs(),
            retry_count + 1
        ),
    );

    // Apply backoff
    thread::sleep(backoff_duration);

    if state.shutdown_flag.load(Ordering::Relaxed) {
        return Ok(());
    }

    // Stop existing process
    stop_server_internal(&state.server_child);

    // Start new process
    start_server_process(app, &config, &state.server_child)?;

    // Wait for health
    match wait_for_health(config.port, Duration::from_secs(20)) {
        Ok(()) => {
            let mut monitor = state
                .monitor_state
                .write()
                .map_err(|_| "Failed to lock monitor state")?;
            monitor.status = ServerStatus::Healthy;
            monitor.last_healthy = Some(Instant::now());
            monitor.consecutive_failures = 0;
            monitor.error_message = None;

            emit_status(app, "healthy", format!("Server restarted on port {}", config.port));

            // Try to show main window if it's not already shown
            if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
                let url = format!("http://{SERVER_HOST}:{}/#/start", config.port);
                if let Ok(target_url) = url.parse::<url::Url>() {
                    let _ = window.navigate(target_url);
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }

            Ok(())
        }
        Err(e) => {
            let mut monitor = state
                .monitor_state
                .write()
                .map_err(|_| "Failed to lock monitor state")?;
            monitor.error_message = Some(e.clone());

            if monitor.retry_count >= state.restart_policy.max_retries {
                monitor.status = ServerStatus::Failed;
                emit_status(app, "failed", "Server failed to start after max retries".to_string());
            }

            Err(e)
        }
    }
}

/// Start server process (similar to start_runtime_server but uses stored config)
fn start_server_process(
    _app: &AppHandle,
    config: &ServerConfig,
    child_slot: &SharedChild,
) -> Result<(), String> {
    let logs_dir = config.data_dir.join("logs");
    std::fs::create_dir_all(&logs_dir).map_err(|e| e.to_string())?;

    // Find sidecar binary
    let node_path = {
        let target_triple = tauri::utils::platform::target_triple()
            .map_err(|e| e.to_string())?;
        let exe_dir = std::env::current_exe()
            .map_err(|e| e.to_string())?
            .parent()
            .map(Path::to_path_buf)
            .ok_or("failed to locate executable dir".to_string())?;

        let candidates = [
            exe_dir.join(format!("{}-{}.exe", NODE_SIDECAR_NAME, target_triple)),
            exe_dir.join(format!("{}.exe", NODE_SIDECAR_NAME)),
            exe_dir.join(format!("{}-{}", NODE_SIDECAR_NAME, target_triple)),
            exe_dir.join(NODE_SIDECAR_NAME),
        ];

        candidates
            .into_iter()
            .find(|p| p.exists())
            .ok_or("Sidecar binary not found".to_string())?
    };

    let server_entry = config.runtime_root.join("server/dist/main.js");
    let web_dist = config.runtime_root.join("webui");
    let runtime_lib_dir = config.runtime_root.join("lib");

    if !node_path.exists() {
        return Err(format!("Node binary not found: {}", node_path.display()));
    }
    if !server_entry.exists() {
        return Err(format!("Server entry not found: {}", server_entry.display()));
    }

    let stdout = std::fs::File::create(logs_dir.join("desktop-http-server.out.log"))
        .map_err(|e| e.to_string())?;
    let stderr = std::fs::File::create(logs_dir.join("desktop-http-server.err.log"))
        .map_err(|e| e.to_string())?;

    let mut command = Command::new(&node_path);
    command
        .arg(clean_path_for_nodejs(&server_entry))
        .current_dir(&config.runtime_root)
        .env("HOST", SERVER_HOST)
        .env("PORT", config.port.to_string())
        .env("EMBED_AGENT_DATA", clean_path_for_nodejs(&config.data_dir))
        .env("EMBED_AGENT_SERVER_URL", &config.server_url)
        .env("EMBED_AGENT_WEB_DIST", clean_path_for_nodejs(&web_dist))
        .env("EMBED_AGENT_DESKTOP", "1")
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));

    if runtime_lib_dir.exists() {
        command.env("DYLD_LIBRARY_PATH", &runtime_lib_dir);
    }

    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let child = command.spawn().map_err(|e| e.to_string())?;

    {
        let mut slot = child_slot
            .lock()
            .map_err(|_| "Failed to lock child slot".to_string())?;
        *slot = Some(child);
    }

    Ok(())
}

/// Shutdown monitoring thread
fn shutdown_monitoring(state: &DesktopState) {
    state.shutdown_flag.store(true, Ordering::Relaxed);

    if let Ok(mut guard) = state.monitor_handle.lock() {
        if let Some(handle) = guard.take() {
            let _ = handle.join();
        }
    }
}

/// Tauri command to get server status
#[tauri::command]
fn get_server_status(state: tauri::State<'_, DesktopState>) -> ServerStatusPayload {
    let monitor = state.monitor_state.read().unwrap();

    let status_str = match monitor.status {
        ServerStatus::Starting => "starting",
        ServerStatus::Healthy => "healthy",
        ServerStatus::Unhealthy => "unhealthy",
        ServerStatus::Crashed => "crashed",
        ServerStatus::Restarting => "restarting",
        ServerStatus::Stopped => "stopped",
        ServerStatus::Failed => "failed",
    };

    ServerStatusPayload {
        status: status_str,
        message: monitor.error_message.clone().unwrap_or_default(),
        retry_count: monitor.retry_count,
        max_retries: state.restart_policy.max_retries,
        last_healthy_ago: monitor.last_healthy.map(|t| t.elapsed().as_secs()),
    }
}

/// Tauri command to restart server manually
#[tauri::command]
fn restart_server(app: tauri::AppHandle, state: tauri::State<'_, DesktopState>) -> Result<(), String> {
    {
        let monitor = state.monitor_state.read().unwrap();
        if monitor.status == ServerStatus::Restarting {
            return Err("Server is already restarting".to_string());
        }
    }

    {
        let mut monitor = state.monitor_state.write().unwrap();
        monitor.retry_count = 0;
        monitor.status = ServerStatus::Crashed;
    }

    attempt_restart(&app, &state)
}

/// Tauri command to stop server manually
#[tauri::command]
fn stop_server_cmd(app: tauri::AppHandle, state: tauri::State<'_, DesktopState>) -> Result<(), String> {
    state.shutdown_flag.store(true, Ordering::Relaxed);

    {
        let mut monitor = state.monitor_state.write().unwrap();
        monitor.status = ServerStatus::Stopped;
    }

    stop_server_internal(&state.server_child);
    emit_status(&app, "stopped", "Server stopped by user".to_string());

    Ok(())
}
