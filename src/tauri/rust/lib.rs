pub mod collector;
pub mod models;
mod remote_history;
mod project_sync;
mod host_key;
pub mod storage;
mod terminal;

use models::{AppSettings, HistoryPoint, HostKeyInfo, InteractionLogSummary, InteractionServerSummary, Project, ProjectDraft, ProjectPathCheck, ProjectSyncProgress, ProjectSyncResult, RemoteCleanupResult, RemoteCleanupSweepResult, Server, ServerDraft, Snapshot};
use std::collections::HashMap;
use std::sync::{atomic::{AtomicU64, Ordering}, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use storage::Database;
use terminal::TerminalManager;
use tauri::{image::Image, menu::{Menu, MenuBuilder, MenuItemBuilder}, tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent}, AppHandle, Emitter, Manager, State};
#[cfg(target_os = "macos")]
use tauri::menu::{SubmenuBuilder, WINDOW_SUBMENU_ID};

#[derive(Default)]
struct InteractionLogStore {
    next_id: AtomicU64,
    state: Mutex<InteractionLogState>,
}

#[derive(Default)]
struct InteractionLogState {
    sent_bytes: u64,
    response_bytes: u64,
    stored_bytes: u64,
    failure_count: u64,
    servers: HashMap<String, InteractionServerState>,
    interactions: HashMap<u64, String>,
}

struct InteractionServerState {
    id: u64,
    server_name: String,
    sent_bytes: u64,
    response_bytes: u64,
    stored_bytes: u64,
    last_started_at: i64,
    last_finished_at: Option<i64>,
    last_command: String,
    status: String,
    error: Option<String>,
}

impl InteractionLogStore {
    fn now_millis() -> i64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_millis() as i64).unwrap_or_default()
    }

    fn begin(&self, server: &Server, command: String) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let sent_bytes = command.len() as u64;
        if let Ok(mut state) = self.state.lock() {
            state.sent_bytes = state.sent_bytes.saturating_add(sent_bytes);
            state.interactions.insert(id, server.id.clone());
            let entry = state.servers.entry(server.id.clone()).or_insert_with(|| InteractionServerState {
                id,
                server_name: server.name.clone(),
                sent_bytes: 0,
                response_bytes: 0,
                stored_bytes: 0,
                last_started_at: 0,
                last_finished_at: None,
                last_command: String::new(),
                status: "success".into(),
                error: None,
            });
            entry.id = id;
            entry.server_name = server.name.clone();
            entry.sent_bytes = entry.sent_bytes.saturating_add(sent_bytes);
            entry.last_started_at = Self::now_millis();
            entry.last_finished_at = None;
            entry.last_command = command;
            entry.status = "running".into();
            entry.error = None;
        }
        id
    }

    fn finish(&self, id: u64, response_bytes: u64, stored_bytes: u64, error: Option<String>) {
        if let Ok(mut state) = self.state.lock() {
            state.response_bytes = state.response_bytes.saturating_add(response_bytes);
            state.stored_bytes = state.stored_bytes.saturating_add(stored_bytes);
            if error.is_some() {
                state.failure_count = state.failure_count.saturating_add(1);
            }
            if let Some(server_id) = state.interactions.remove(&id)
                && let Some(entry) = state.servers.get_mut(&server_id)
            {
                entry.response_bytes = entry.response_bytes.saturating_add(response_bytes);
                entry.stored_bytes = entry.stored_bytes.saturating_add(stored_bytes);
                if entry.id == id {
                    entry.last_finished_at = Some(Self::now_millis());
                    entry.status = if error.is_some() { "error".into() } else { "success".into() };
                    entry.error = error;
                }
            }
        }
    }

    fn summary(&self, local_storage_bytes: u64) -> Result<InteractionLogSummary, String> {
        let state = self.state.lock().map_err(|error| error.to_string())?;
        let mut servers: Vec<_> = state.servers.iter().map(|(server_id, entry)| InteractionServerSummary {
            server_id: server_id.clone(),
            server_name: entry.server_name.clone(),
            sent_bytes: entry.sent_bytes,
            response_bytes: entry.response_bytes,
            stored_bytes: entry.stored_bytes,
            last_started_at: entry.last_started_at,
            last_finished_at: entry.last_finished_at,
            last_command: entry.last_command.clone(),
            status: entry.status.clone(),
            error: entry.error.clone(),
        }).collect();
        servers.sort_by(|left, right| left.server_name.cmp(&right.server_name));
        Ok(InteractionLogSummary { sent_bytes: state.sent_bytes, response_bytes: state.response_bytes, stored_bytes: state.stored_bytes, local_storage_bytes, failure_count: state.failure_count, servers })
    }
}

#[cfg(test)]
mod interaction_log_tests {
    use super::*;

    fn server(id: &str, name: &str) -> Server {
        Server {
            id: id.into(), name: name.into(), host: "10.0.0.1".into(), port: 22,
            username: "test".into(), sampling_interval_seconds: 2, history_retention_days: 90,
            sort_order: 0, auth_method: "sshConfig".into(),
            status: "online".into(), last_error: None, last_seen_at: None,
        }
    }

    #[test]
    fn aggregates_session_traffic_and_latest_state_per_server() {
        let logs = InteractionLogStore::default();
        let first = server("a", "Alpha");
        let second = server("b", "Beta");
        let first_id = logs.begin(&first, "abc".into());
        logs.finish(first_id, 20, 7, None);
        let second_id = logs.begin(&second, "hello".into());
        logs.finish(second_id, 4, 0, Some("offline".into()));

        let summary = logs.summary(512).unwrap();
        assert_eq!(summary.sent_bytes, 8);
        assert_eq!(summary.response_bytes, 24);
        assert_eq!(summary.stored_bytes, 7);
        assert_eq!(summary.local_storage_bytes, 512);
        assert_eq!(summary.failure_count, 1);
        assert_eq!(summary.servers.len(), 2);
        assert_eq!(summary.servers[0].server_name, "Alpha");
        assert_eq!(summary.servers[1].status, "error");
    }

    #[test]
    fn overlapping_interactions_keep_all_bytes_without_overwriting_newer_state() {
        let logs = InteractionLogStore::default();
        let target = server("a", "Alpha");
        let old_id = logs.begin(&target, "old".into());
        let new_id = logs.begin(&target, "new".into());
        logs.finish(old_id, 11, 3, Some("old failure".into()));
        assert_eq!(logs.summary(0).unwrap().servers[0].status, "running");
        logs.finish(new_id, 7, 2, None);

        let summary = logs.summary(0).unwrap();
        assert_eq!(summary.response_bytes, 18);
        assert_eq!(summary.stored_bytes, 5);
        assert_eq!(summary.failure_count, 1);
        assert_eq!(summary.servers[0].response_bytes, 18);
        assert_eq!(summary.servers[0].status, "success");
    }
}

#[tauri::command]
fn get_interaction_log_summary(database: State<'_, Database>, logs: State<'_, InteractionLogStore>) -> Result<InteractionLogSummary, String> {
    logs.summary(database.storage_size_bytes())
}

#[tauri::command]
fn list_servers(database: State<'_, Database>) -> Result<Vec<Server>, String> {
    database.list_servers()
}

#[tauri::command]
fn save_server(database: State<'_, Database>, draft: ServerDraft) -> Result<Server, String> {
    database.save_server(draft)
}

#[tauri::command]
async fn delete_server(database: State<'_, Database>, server_id: String) -> Result<RemoteCleanupResult, String> {
    let server = database.get_server(&server_id)?;
    let password = if server.auth_method == "password" { database.get_password(&server_id, false).unwrap_or(None) } else { None };
    match remote_history::remove(&server, password.as_deref()).await {
        Ok(()) => {
            database.delete_server(&server_id)?;
            Ok(RemoteCleanupResult { remote_cleaned: true, cleanup_pending: false, message: format!("已删除“{}”及其本地与远端 Termio 数据", server.name) })
        }
        Err(error) => {
            let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|reason| reason.to_string())?.as_secs() as i64;
            database.enqueue_remote_cleanup(&server, now, &error)?;
            database.delete_server_record(&server_id, false)?;
            Ok(RemoteCleanupResult { remote_cleaned: false, cleanup_pending: true, message: format!("已删除“{}”的本地记录；远端数据清理将在重新连接后自动重试 24 小时", server.name) })
        }
    }
}

#[tauri::command]
fn reorder_servers(database: State<'_, Database>, server_ids: Vec<String>) -> Result<(), String> {
    database.reorder_servers(&server_ids)
}

#[tauri::command]
async fn test_server_draft(database: State<'_, Database>, draft: ServerDraft) -> Result<String, String> {
    if draft.host.trim().is_empty() { return Err("请填写主机地址".into()); }
    if draft.username.trim().is_empty() { return Err("请填写 SSH 用户名".into()); }
    if !matches!(draft.auth_method.as_str(), "sshConfig" | "password") { return Err("不支持的 SSH 认证方式".into()); }
    let server = Server {
        id: "server-test".into(),
        name: if draft.name.trim().is_empty() { draft.host.clone() } else { draft.name.clone() },
        host: draft.host.clone(),
        port: draft.port,
        username: draft.username.clone(),
        sampling_interval_seconds: draft.sampling_interval_seconds,
        history_retention_days: draft.history_retention_days,
        sort_order: 0,
        auth_method: draft.auth_method.clone(),
        status: "unknown".into(),
        last_error: None,
        last_seen_at: None,
    };
    let stored_password = if server.auth_method == "password" && draft.password.as_deref().map(str::trim).filter(|value| !value.is_empty()).is_none() {
        if let Some(server_id) = draft.id.as_deref() { database.get_password(server_id, true)? } else { None }
    } else { None };
    let password = if server.auth_method == "password" { draft.password.as_deref().map(str::trim).filter(|value| !value.is_empty()).or(stored_password.as_deref()) } else { None };
    terminal::test_connection(&server, password).await
}

#[tauri::command]
fn start_terminal(app: tauri::AppHandle, database: State<'_, Database>, terminals: State<'_, TerminalManager>, server_id: String, columns: u16, rows: u16, gpu_index: Option<u32>, accelerator_vendor: Option<String>) -> Result<String, String> {
    let server = database.get_server(&server_id)?;
    let password = if server.auth_method == "password" { database.get_password(&server_id, true)? } else { None };
    terminals.start(app, &server, password.as_deref(), columns, rows, gpu_index, accelerator_vendor.as_deref().unwrap_or("nvidia"))
}

#[tauri::command]
fn write_terminal(terminals: State<'_, TerminalManager>, session_id: String, data: String) -> Result<(), String> {
    terminals.write(&session_id, data.as_bytes())
}

#[tauri::command]
fn resize_terminal(terminals: State<'_, TerminalManager>, session_id: String, columns: u16, rows: u16) -> Result<(), String> {
    terminals.resize(&session_id, columns, rows)
}

#[tauri::command]
fn close_terminal(terminals: State<'_, TerminalManager>, session_id: String) -> Result<(), String> {
    terminals.close(&session_id)
}

#[tauri::command]
async fn collect_server(database: State<'_, Database>, logs: State<'_, InteractionLogStore>, server_id: String, include_processes: bool, include_disks: bool, record_history: bool, allow_credential_prompt: bool) -> Result<Snapshot, String> {
    let server = database.get_server(&server_id)?;
    let log_id = logs.begin(&server, collector::collection_display_command(&server, include_processes, include_disks));
    let password = match if server.auth_method == "password" { database.get_password(&server_id, allow_credential_prompt) } else { Ok(None) } {
        Ok(password) => password,
        Err(error) => {
            logs.finish(log_id, 0, 0, Some(error.clone()));
            return Err(error);
        }
    };
    match collector::collect_with_password_detailed(&server, password.as_deref(), include_processes, include_disks).await {
        Ok(collected) => {
            let response_bytes = collected.response_bytes;
            let snapshot = collected.snapshot;
            let mut stored_bytes = 0u64;
            let stored = (|| -> Result<(), String> {
                database.update_status(&server_id, &snapshot.status, snapshot.nvidia_message.as_deref(), Some(snapshot.timestamp))?;
                if record_history {
                    stored_bytes = serde_json::to_vec(&snapshot).map_err(|error| error.to_string())?.len() as u64;
                    database.save_snapshot(&snapshot)?;
                }
                if snapshot.processes_sampled {
                    let usage_rows = database.save_local_usage(&snapshot)?;
                    stored_bytes = stored_bytes.saturating_add((usage_rows as u64).saturating_mul(96));
                }
                Ok(())
            })();
            match stored {
                Ok(()) => {
                    logs.finish(log_id, response_bytes, stored_bytes, None);
                    Ok(snapshot)
                }
                Err(error) => {
                    logs.finish(log_id, response_bytes, stored_bytes, Some(error.clone()));
                    Err(error)
                }
            }
        }
        Err(error) => {
            logs.finish(log_id, 0, 0, Some(error.clone()));
            Err(error)
        }
    }
}

#[tauri::command]
async fn get_history(app: AppHandle, server_id: String, from_timestamp: i64, bucket_seconds: Option<i64>) -> Result<Vec<HistoryPoint>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let database = app.state::<Database>();
        match bucket_seconds.filter(|seconds| *seconds > 0) {
            Some(seconds) => database.get_compacted_history(&server_id, from_timestamp, seconds),
            None => database.get_recent_history(&server_id, from_timestamp),
        }
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn retry_remote_cleanups(database: State<'_, Database>) -> Result<RemoteCleanupSweepResult, String> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_secs() as i64;
    let mut result = RemoteCleanupSweepResult { cleaned_names: Vec::new(), pending_names: Vec::new(), expired_names: Vec::new() };
    for task in database.list_remote_cleanup_tasks()? {
        if task.expires_at <= now {
            database.finish_remote_cleanup(&task.server.id, task.server.auth_method == "password")?;
            result.expired_names.push(task.server.name);
            continue;
        }
        let password = if task.server.auth_method == "password" { database.get_password(&task.server.id, false)? } else { None };
        match remote_history::remove(&task.server, password.as_deref()).await {
            Ok(()) => {
                database.finish_remote_cleanup(&task.server.id, task.server.auth_method == "password")?;
                result.cleaned_names.push(task.server.name);
            }
            Err(error) => {
                database.update_remote_cleanup_error(&task.server.id, &error)?;
                result.pending_names.push(task.server.name);
            }
        }
    }
    Ok(result)
}

#[tauri::command]
fn list_projects(database: State<'_, Database>) -> Result<Vec<Project>, String> {
    database.list_projects()
}

#[tauri::command]
fn save_project(database: State<'_, Database>, draft: ProjectDraft) -> Result<Project, String> {
    database.save_project(draft)
}

#[tauri::command]
fn delete_project(database: State<'_, Database>, project_id: String) -> Result<(), String> {
    database.delete_project(&project_id)
}

#[tauri::command]
async fn probe_project_paths(database: State<'_, Database>, draft: ProjectDraft) -> Result<Vec<ProjectPathCheck>, String> {
    project_sync::probe(&database, &draft).await
}

#[tauri::command]
async fn suggest_project_paths(database: State<'_, Database>, server_id: String, query: String) -> Result<Vec<String>, String> {
    let server = database.get_server(&server_id)?;
    let password = if server.auth_method == "password" { database.get_password(&server.id, false)? } else { None };
    project_sync::suggest_paths(&server, password.as_deref(), &query).await
}

#[tauri::command]
async fn inspect_project(database: State<'_, Database>, project_id: String) -> Result<Project, String> {
    let project = database.get_project(&project_id)?;
    project_sync::inspect(&database, &project).await
}

#[tauri::command]
async fn inspect_project_source(database: State<'_, Database>, project_id: String) -> Result<Project, String> {
    let project = database.get_project(&project_id)?;
    project_sync::inspect_source(&database, &project).await
}

#[tauri::command]
async fn sync_project(database: State<'_, Database>, project_id: String, target_server_id: String, force: bool) -> Result<ProjectSyncResult, String> {
    let project = database.get_project(&project_id)?;
    project_sync::sync(&database, &project, &target_server_id, force).await
}

#[tauri::command]
fn list_project_sync_progress() -> Vec<ProjectSyncProgress> {
    project_sync::list_progress()
}

#[tauri::command]
fn cancel_project_sync(project_id: String, target_server_id: String) -> Result<(), String> {
    if project_sync::cancel(&project_id, &target_server_id) { Ok(()) } else { Err("找不到正在运行的同步任务".into()) }
}

fn default_ssh_username() -> String {
    std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_else(|_| "root".into())
}

fn parse_ssh_config_hosts(content: &str) -> Vec<ServerDraft> {
    #[derive(Default)]
    struct HostBlock {
        aliases: Vec<String>,
        user: Option<String>,
        port: Option<u16>,
    }
    fn finish(block: HostBlock, output: &mut Vec<ServerDraft>) {
        for alias in block.aliases.into_iter().filter(|value| !value.contains('*') && !value.contains('?') && !value.starts_with('!')) {
            output.push(ServerDraft {
                id: None,
                name: alias.clone(),
                host: alias,
                port: block.port.unwrap_or(22),
                username: block.user.clone().unwrap_or_else(default_ssh_username),
                sampling_interval_seconds: 2,
                history_retention_days: 2,
                auth_method: "sshConfig".into(),
                password: None,
                save_password: false,
            });
        }
    }

    let mut output = Vec::new();
    let mut current: Option<HostBlock> = None;
    for raw_line in content.lines() {
        let line = raw_line.split('#').next().unwrap_or("").trim();
        if line.is_empty() { continue; }
        let mut parts = line.split_whitespace();
        let key = parts.next().unwrap_or("").to_ascii_lowercase();
        let value = parts.collect::<Vec<_>>().join(" ");
        if key == "host" {
            if let Some(block) = current.take() { finish(block, &mut output); }
            current = Some(HostBlock { aliases: value.split_whitespace().map(str::to_string).collect(), ..Default::default() });
        } else if let Some(block) = current.as_mut() {
            match key.as_str() {
                "user" => block.user = Some(value),
                "port" => block.port = value.parse().ok(),
                _ => {}
            }
        }
    }
    if let Some(block) = current { finish(block, &mut output); }
    output
}

#[tauri::command]
fn import_ssh_config(path: Option<String>) -> Result<Vec<ServerDraft>, String> {
    let path = match path {
        Some(value) if !value.trim().is_empty() => std::path::PathBuf::from(value),
        _ => dirs::home_dir().ok_or_else(|| "无法定位用户主目录".to_string())?.join(".ssh").join("config"),
    };
    let content = std::fs::read_to_string(&path).map_err(|error| format!("无法读取 {}：{error}", path.display()))?;
    Ok(parse_ssh_config_hosts(&content))
}

#[tauri::command]
fn get_settings(database: State<'_, Database>) -> Result<AppSettings, String> {
    database.get_settings()
}

#[tauri::command]
fn save_settings(database: State<'_, Database>, settings: AppSettings) -> Result<AppSettings, String> {
    if settings.default_sampling_interval_seconds < 2 {
        return Err("前台采样间隔不能短于 2 秒".into());
    }
    if settings.background_sampling_interval_seconds < 5 || settings.process_interval_seconds < 2 {
        return Err("后台采样不能短于 5 秒，进程刷新不能短于 2 秒".into());
    }
    if !matches!(settings.close_behavior.as_str(), "minimize" | "exit") {
        return Err("窗口关闭行为设置无效".into());
    }
    let settings = AppSettings { history_retention_days: 2, ..settings };
    database.save_settings(&settings)?;
    Ok(settings)
}

#[tauri::command]
async fn scan_host_key(database: State<'_, Database>, server_id: String) -> Result<HostKeyInfo, String> {
    let server = database.get_server(&server_id)?;
    host_key::scan(&server).await
}

#[tauri::command]
fn trust_host_key(database: State<'_, Database>, info: HostKeyInfo) -> Result<(), String> {
    let server = database.get_server(&info.server_id)?;
    host_key::trust(&server, &info)
}

#[tauri::command]
async fn install_nvidia_driver(database: State<'_, Database>, server_id: String, confirmed: bool) -> Result<String, String> {
    if !confirmed { return Err("必须在界面明确确认后才能安装驱动".into()); }
    let server = database.get_server(&server_id)?;
    let password = if server.auth_method == "password" { database.get_password(&server_id, true)? } else { None };
    collector::install_nvidia_driver(&server, password.as_deref()).await
}

#[tauri::command]
async fn terminate_process(database: State<'_, Database>, server_id: String, pid: u32, confirmed: bool) -> Result<String, String> {
    if !confirmed { return Err("必须在界面完成二次确认后才能结束进程".into()); }
    let server = database.get_server(&server_id)?;
    let password = if server.auth_method == "password" { database.get_password(&server_id, true)? } else { None };
    collector::terminate_process_tree(&server, password.as_deref(), pid).await
}


fn tray_pixel(rgba: &mut [u8], width: usize, x: usize, y: usize, alpha: u8) {
    if x >= width || y >= 18 { return; }
    let index = (y * width + x) * 4;
    rgba[index..index + 4].copy_from_slice(&[0, 0, 0, alpha]);
}

fn render_tray_image() -> (Vec<u8>, u32, u32) {
    let width = 18usize;
    let mut rgba = vec![0u8; width * 18 * 4];
    for x in 2..16 {
        let y = if x < 6 { 10 } else if x < 9 { 5 } else if x < 12 { 12 } else { 7 };
        for offset in 0..2 {
            tray_pixel(&mut rgba, width, x, y + offset, 255);
        }
    }
    (rgba, width as u32, 18)
}

fn tray_image() -> Image<'static> {
    let (rgba, width, height) = render_tray_image();
    Image::new_owned(rgba, width, height)
}

#[cfg(test)]
mod ssh_config_import_tests {
    use super::parse_ssh_config_hosts;

    #[test]
    fn imports_only_connection_coordinates_and_ignores_wildcards() {
        let hosts = parse_ssh_config_hosts("Host *\n  ServerAliveInterval 30\nHost gpu-a\n HostName 10.0.0.10\n User alice\n Port 2222\n IdentityFile ~/.ssh/id_ed25519\n ProxyJump bastion\nHost gpu-*\n HostName ignored\n");
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].name, "gpu-a");
        assert_eq!(hosts[0].host, "gpu-a");
        assert_eq!(hosts[0].username, "alice");
        assert_eq!(hosts[0].port, 2222);
        assert_eq!(hosts[0].auth_method, "sshConfig");
    }
}


// On Windows the running Termio process owns a named mutex and activation event.
// A second launch signals that event and exits before opening SQLite or creating
// another window. No extra Cargo dependencies or lockfile changes are required.
#[cfg(target_os = "windows")]
mod single_instance {
    use std::{ffi::c_void, io, ptr};

    type Handle = *mut c_void;
    const ERROR_ALREADY_EXISTS: u32 = 183;
    const WAIT_OBJECT_0: u32 = 0;
    const INFINITE: u32 = u32::MAX;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateEventW(attributes: *const c_void, manual_reset: i32, initial_state: i32, name: *const u16) -> Handle;
        fn CreateMutexW(attributes: *const c_void, initial_owner: i32, name: *const u16) -> Handle;
        fn GetLastError() -> u32;
        fn SetEvent(event: Handle) -> i32;
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    // Windows Local\ namespace scopes these objects to the current logon session.
    fn wide_name(name: &str) -> Vec<u16> {
        name.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub struct Guard {
        mutex: Handle,
        event: Handle,
    }

    impl Guard {
        pub fn event_handle(&self) -> usize {
            self.event as usize
        }
    }

    pub fn listen_for_relaunch(event: usize, app: tauri::AppHandle) {
        // The guard in run() owns this event for the full application lifetime.
        std::thread::spawn(move || {
            loop {
                if unsafe { WaitForSingleObject(event as Handle, INFINITE) } != WAIT_OBJECT_0 {
                    break;
                }
                let app_for_window = app.clone();
                if app.run_on_main_thread(move || super::restore_main_window(&app_for_window)).is_err() {
                    break;
                }
            }
        });
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.mutex);
                CloseHandle(self.event);
            }
        }
    }

    // Some(guard) means this is the first process; None means the existing
    // process has been asked to show its original window.
    pub fn acquire() -> io::Result<Option<Guard>> {
        let event_name = wide_name("Local\\com.termio.desktop.activation.v1");
        let mutex_name = wide_name("Local\\com.termio.desktop.single-instance.v1");
        unsafe {
            // The event is created before the mutex so even a nearly simultaneous
            // second launch can signal it before the first GUI is ready.
            let event = CreateEventW(ptr::null(), 0, 0, event_name.as_ptr());
            if event.is_null() {
                return Err(io::Error::last_os_error());
            }
            let mutex = CreateMutexW(ptr::null(), 0, mutex_name.as_ptr());
            let mutex_error = GetLastError();
            if mutex.is_null() {
                CloseHandle(event);
                return Err(io::Error::from_raw_os_error(mutex_error as i32));
            }
            if mutex_error == ERROR_ALREADY_EXISTS {
                let signaled = SetEvent(event);
                let error = if signaled == 0 { Some(io::Error::last_os_error()) } else { None };
                CloseHandle(mutex);
                CloseHandle(event);
                return error.map_or(Ok(None), Err);
            }
            Ok(Some(Guard { mutex, event }))
        }
    }
}

// Restore the *existing* webview without reloading the frontend or losing
// terminal sessions. Works both from the taskbar and when hidden to the tray.
fn restore_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn build_tray_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    // The left mouse button opens the existing window directly. Keep the
    // context menu dedicated to the right mouse button and explicit exit.
    let quit = MenuItemBuilder::with_id("quit", "退出Termio").build(app)?;
    Ok(MenuBuilder::new(app).item(&quit).build()?)
}

#[cfg(target_os = "macos")]
fn build_application_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    let about = MenuItemBuilder::with_id("menu-about", "关于 Termio").build(app)?;
    let settings = MenuItemBuilder::with_id("menu-settings", "设置…").accelerator("CmdOrCtrl+,").build(app)?;
    let quit = MenuItemBuilder::with_id("menu-quit", "退出 Termio").accelerator("CmdOrCtrl+Q").build(app)?;
    let termio = SubmenuBuilder::new(app, "Termio").items(&[&about, &settings]).separator().item(&quit).build()?;

    let edit = SubmenuBuilder::new(app, "编辑")
        .undo_with_text("撤销")
        .redo_with_text("重做")
        .separator()
        .cut_with_text("剪切")
        .copy_with_text("复制")
        .paste_with_text("粘贴")
        .select_all_with_text("全选")
        .build()?;

    let add_server = MenuItemBuilder::with_id("menu-add-server", "添加服务器…").accelerator("CmdOrCtrl+N").build(app)?;
    let refresh_all = MenuItemBuilder::with_id("menu-refresh-all", "刷新全部服务器").accelerator("CmdOrCtrl+R").build(app)?;
    let servers = SubmenuBuilder::new(app, "服务器").item(&add_server).separator().item(&refresh_all).build()?;

    let fleet = MenuItemBuilder::with_id("menu-view-fleet", "算力总览").accelerator("CmdOrCtrl+1").build(app)?;
    let idle = MenuItemBuilder::with_id("menu-view-idle", "空闲算力").accelerator("CmdOrCtrl+2").build(app)?;
    let view = SubmenuBuilder::new(app, "查看").items(&[&fleet, &idle]).build()?;

    let window = SubmenuBuilder::with_id(app, WINDOW_SUBMENU_ID, "窗口")
        .minimize_with_text("最小化")
        .maximize_with_text("缩放")
        .fullscreen_with_text("进入全屏幕")
        .separator()
        .bring_all_to_front_with_text("全部置于顶层")
        .build()?;

    Ok(MenuBuilder::new(app).items(&[&termio, &edit, &servers, &view, &window]).build()?)
}

#[tauri::command]
fn window_minimize(window: tauri::WebviewWindow) -> Result<(), String> {
    // Always minimize normally so Windows keeps the window on the taskbar.
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
fn window_toggle_maximize(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.is_maximized().map_err(|error| error.to_string())? {
        window.unmaximize().map_err(|error| error.to_string())
    } else {
        window.maximize().map_err(|error| error.to_string())
    }
}

#[tauri::command]
fn window_close(window: tauri::WebviewWindow) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

// Place SQLite beside the application executable, regardless of how it was launched.
// The process working directory is not reliable when started from a shortcut.
fn local_data_dir() -> Result<std::path::PathBuf, std::io::Error> {
    let executable = std::env::current_exe()?;
    let directory = executable.parent().ok_or_else(|| std::io::Error::other("无法确定 Termio 程序目录"))?;
    Ok(directory.join("data"))
}

pub fn run() {
    #[cfg(target_os = "windows")]
    let single_instance_guard = match single_instance::acquire() {
        Ok(Some(guard)) => guard,
        Ok(None) => return, // Reuse the running window; never start a second app.
        Err(error) => panic!("无法检查 Termio 是否已经运行：{error}"),
    };

    #[cfg(target_os = "windows")]
    let activation_event = single_instance_guard.event_handle();

    tauri::Builder::default()
        .setup(move |app| {
            // Both installed and portable editions keep their database in ./data
            // relative to the executable, never in the OS user-data directory.
            let database_path = local_data_dir()?.join("termio.sqlite");
            let database = Database::open(&database_path).map_err(|error| Box::<dyn std::error::Error>::from(std::io::Error::other(format!("无法打开本地数据库 {}：{error}。请确保程序目录可写。", database_path.display()))))?;
            app.manage(database);
            app.manage(TerminalManager::default());
            app.manage(InteractionLogStore::default());

            #[cfg(target_os = "windows")]
            single_instance::listen_for_relaunch(activation_event, app.handle().clone());

            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_decorations(false);
                let _ = window.unmaximize();
                let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(1500.0, 900.0)));
            }

            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unmaximize();
                let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(1320.0, 820.0)));
            }

            #[cfg(target_os = "macos")]
            app.set_menu(build_application_menu(&app.handle())?)?;

            let menu = build_tray_menu(&app.handle())?;
            TrayIconBuilder::with_id("termio-tray")
                .icon(tray_image())
                .icon_as_template(true)
                .tooltip("Termio · GPU 与 CPU 监控")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    // Only react once when the left button is released.
                    // Right click remains reserved for the "退出Termio" menu.
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event {
                        restore_main_window(tray.app_handle());
                    }
                })
                .on_menu_event(|app, event| {
                    if event.id().as_ref() == "quit" {
                        app.state::<TerminalManager>().close_all();
                        app.exit(0);
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "menu-quit" => {
                app.state::<TerminalManager>().close_all();
                app.exit(0);
            }
            id if id.starts_with("menu-") => {
                restore_main_window(app);
                let _ = app.emit("app-menu-action", id);
            }
            _ => {}
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" { return; }
                api.prevent_close();
                // Both native titlebar close and the custom X button use this
                // handler. Missing settings fall back to hiding to the tray.
                let should_exit = window.app_handle().state::<Database>()
                    .get_settings()
                    .is_ok_and(|settings| settings.close_behavior == "exit");
                if should_exit {
                    window.app_handle().state::<TerminalManager>().close_all();
                    window.app_handle().exit(0);
                } else {
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![list_servers, save_server, delete_server, retry_remote_cleanups, reorder_servers, test_server_draft, start_terminal, write_terminal, resize_terminal, close_terminal, collect_server, get_interaction_log_summary, get_history, list_projects, save_project, delete_project, probe_project_paths, suggest_project_paths, inspect_project, inspect_project_source, sync_project, list_project_sync_progress, cancel_project_sync, import_ssh_config, get_settings, save_settings, scan_host_key, trust_host_key, install_nvidia_driver, terminate_process, window_minimize, window_toggle_maximize, window_close])
        .run(tauri::generate_context!())
        .expect("Termio 启动失败");
}
