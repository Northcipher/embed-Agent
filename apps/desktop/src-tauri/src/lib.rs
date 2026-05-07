use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::path::BaseDirectory;
use tauri::{App, AppHandle, Emitter, Manager, RunEvent};

const SERVER_HOST: &str = "127.0.0.1";
const WINDOW_LABEL: &str = "main";
const NODE_SIDECAR_NAME: &str = "embed-agent-node";

type SharedChild = Arc<Mutex<Option<Child>>>;

#[derive(Clone, serde::Serialize)]
struct DesktopStatusPayload {
    status: &'static str,
    message: String,
}

#[derive(Clone)]
struct DesktopState {
    server_child: SharedChild,
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let server_child = Arc::new(Mutex::new(None));
            app.manage(DesktopState {
                server_child: Arc::clone(&server_child),
            });

            let starting_message = "Preparing local runtime".to_string();
            emit_status(app.handle(), "starting", starting_message.clone());
            let _ = show_startup_window(app.handle(), "starting", &starting_message);

            match initialize_runtime(app, Arc::clone(&server_child)) {
                Ok(server_url) => {
                    if let Err(error) = show_main_window(app.handle(), &server_url) {
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
        .build(tauri::generate_context!())
        .expect("failed to build desktop shell")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                stop_server(app);
            }
        });
}

fn initialize_runtime(app: &App, server_child: SharedChild) -> Result<String, String> {
    let runtime_root = prepare_runtime_root(app).map_err(describe_tauri_error)?;
    let data_dir = prepare_data_dir(app).map_err(describe_tauri_error)?;
    ensure_default_config(&data_dir).map_err(describe_tauri_error)?;
    start_runtime_server(app, &runtime_root, &data_dir, server_child).map_err(describe_tauri_error)
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

fn prepare_data_dir(app: &App) -> tauri::Result<PathBuf> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| tauri::Error::Anyhow(e.into()))?
        .join("data");
    std::fs::create_dir_all(&dir).map_err(|e| tauri::Error::Anyhow(e.into()))?;
    Ok(dir)
}

fn ensure_default_config(data_dir: &Path) -> tauri::Result<()> {
    std::fs::create_dir_all(data_dir).map_err(|e| tauri::Error::Anyhow(e.into()))?;

    let system_path = data_dir.join("system.yml");
    if !system_path.exists() {
        std::fs::write(
      &system_path,
      format!(
        "runtime:\n  retry:\n    max_retries: 3\n    intervals_sec: [2, 5, 10]\n    retryable: [\"timeout\", \"connection_lost\"]\n  rule_policy:\n    fatal_patterns: [\"Kernel panic\", \"Watchdog reset\"]\n    warning_patterns: [\"error\", \"FAILED\"]\n    silence_timeout_sec: 60\n  ring_buffer:\n    max_lines: 500\n    default_before: 200\n    default_after: 80\n  step_executor:\n    max_timeout_sec: 3600\n    default_timeout_sec: 60\nstorage:\n  data_root: {}\n  max_evidence_bytes: 104857600\n  cleanup:\n    keep_completed_days: 30\n    keep_failed_days: 90\n    max_episodes_per_target: 100\nnotifications:\n  enabled: false\nsecurity:\n  allowed_shell_commands: [\"echo\", \"uname\", \"dmesg\", \"cat\", \"true\", \"false\"]\n  max_command_length: 4096\n  block_unsafe_patterns: true\nobserver:\n  debounce_sec: 30\n  max_concurrent_per_run: 1\n  default_checkpoint_interval_sec: 300\n  circuit_breaker:\n    max_failures: 3\n    probe_after_sec: 300\n  warning_escalation:\n    threshold: 5\n    window_sec: 300\nprompt_version: \"1\"\n",
        serde_json::to_string(&data_dir.display().to_string()).unwrap_or_else(|_| "\".embed-agent\"".to_string())
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
        .arg(&server_entry)
        .current_dir(runtime_root)
        .env("HOST", SERVER_HOST)
        .env("PORT", server_port.to_string())
        .env("EMBED_AGENT_DATA", data_dir)
        .env("EMBED_AGENT_SERVER_URL", &server_url)
        .env("EMBED_AGENT_WEB_DIST", &web_dist)
        .env("EMBED_AGENT_DESKTOP", "1")
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));

    if runtime_lib_dir.exists() {
        command.env("DYLD_LIBRARY_PATH", &runtime_lib_dir);
    }

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
        if let Ok(mut slot) = state.server_child.lock() {
            if let Some(mut child) = slot.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}
