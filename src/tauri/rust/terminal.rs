use crate::{collector::configured_shared_ssh_command, models::Server};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    process::Stdio,
    sync::{Arc, Mutex},
    thread,
};
use tauri::{AppHandle, Emitter};
use tokio::time::{timeout, Duration};
use uuid::Uuid;

struct TerminalSession {
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    master: Box<dyn MasterPty + Send>,
}

#[derive(Default)]
pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutput {
    session_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExit {
    session_id: String,
}

pub async fn test_connection(server: &Server, password: Option<&str>) -> Result<String, String> {
    let (mut command, target) = configured_shared_ssh_command(server, password)?;
    command.arg(target).arg("pwd").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let output = timeout(Duration::from_secs(12), command.output()).await
        .map_err(|_| format!("连接 {} 超时（12 秒）", server.name))?
        .map_err(|error| format!("无法启动系统 ssh：{error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(crate::collector::classify_ssh_error(&stderr));
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(if path.is_empty() { "连接成功".into() } else { format!("连接成功 · {path}") })
}

impl TerminalManager {
    pub fn start(
        &self,
        app: AppHandle,
        server: &Server,
        password: Option<&str>,
        columns: u16,
        rows: u16,
        gpu_index: Option<u32>,
        accelerator_vendor: &str,
    ) -> Result<String, String> {
        let pty = native_pty_system();
        let pair = pty.openpty(PtySize {
            rows: rows.max(2),
            cols: columns.max(2),
            pixel_width: 0,
            pixel_height: 0,
        }).map_err(|error| format!("无法创建终端 PTY：{error}"))?;

        let mut command = configured_ssh_command(server, password)?;
        if let Some(index) = gpu_index {
            let variable = if accelerator_vendor == "ascend" { "ASCEND_RT_VISIBLE_DEVICES" } else { "CUDA_VISIBLE_DEVICES" };
            command.arg(format!("export {variable}={index}; exec \"${{SHELL:-/bin/sh}}\" -l"));
        }
        let mut child = pair.slave.spawn_command(command).map_err(|error| format!("无法启动 SSH 终端：{error}"))?;
        drop(pair.slave);
        let mut reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => {
                let _ = child.kill();
                return Err(format!("无法读取终端输出：{error}"));
            }
        };
        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(error) => {
                let _ = child.kill();
                return Err(format!("无法写入终端：{error}"));
            }
        };
        let session_id = Uuid::new_v4().to_string();
        // If the manager lock is poisoned, terminate the just-spawned child;
        // otherwise it would keep running without a registered session.
        match self.sessions.lock() {
            Ok(mut sessions) => {
                sessions.insert(session_id.clone(), TerminalSession {
                    writer,
                    child,
                    master: pair.master,
                });
            }
            Err(error) => {
                let _ = child.kill();
                return Err(format!("无法注册终端会话：{error}"));
            }
        }

        let sessions = Arc::clone(&self.sessions);
        let event_session_id = session_id.clone();
        let reader_thread = thread::Builder::new()
            .name("termio-ssh-reader".into())
            .spawn(move || {
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(length) => {
                        let _ = app.emit("terminal-output", TerminalOutput {
                            session_id: event_session_id.clone(),
                            data: STANDARD.encode(&buffer[..length]),
                        });
                    }
                }
            }
            // The remote shell may exit without the user closing the tab.
            // Reap the session so write/resize reject stale identifiers.
            if let Ok(mut sessions) = sessions.lock() {
                sessions.remove(&event_session_id);
            }
            let _ = app.emit("terminal-exit", TerminalExit { session_id: event_session_id });
        });
        if let Err(error) = reader_thread {
            let _ = self.close(&session_id);
            return Err(format!("无法启动终端读取线程：{error}"));
        }
        Ok(session_id)
    }

    pub fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|error| error.to_string())?;
        let session = sessions.get_mut(session_id).ok_or("终端会话已关闭")?;
        session.writer.write_all(data).and_then(|_| session.writer.flush()).map_err(|error| format!("终端写入失败：{error}"))
    }

    pub fn resize(&self, session_id: &str, columns: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().map_err(|error| error.to_string())?;
        let session = sessions.get(session_id).ok_or("终端会话已关闭")?;
        session.master.resize(PtySize { rows: rows.max(2), cols: columns.max(2), pixel_width: 0, pixel_height: 0 }).map_err(|error| format!("终端尺寸调整失败：{error}"))
    }

    pub fn close(&self, session_id: &str) -> Result<(), String> {
        let Some(mut session) = self.sessions.lock().map_err(|error| error.to_string())?.remove(session_id) else { return Ok(()); };
        // The reader removes naturally ended sessions; an existing session
        // should still report real termination errors to its caller.
        session.child.kill().map_err(|error| format!("终端关闭失败：{error}"))
    }

    pub fn close_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, mut session) in sessions.drain() {
                let _ = session.child.kill();
            }
        }
    }
}

fn configured_ssh_command(server: &Server, password: Option<&str>) -> Result<CommandBuilder, String> {
    let mut command = CommandBuilder::new("ssh");
    command.args(["-tt", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2", "-o", "StrictHostKeyChecking=yes"]);
    if server.auth_method == "password" {
        command.args(["-F", if cfg!(windows) { "NUL" } else { "/dev/null" }]);
        let password = password.ok_or("没有可用密码；请重新编辑服务器并输入密码")?;
        let executable = std::env::current_exe().map_err(|error| format!("无法定位 Termio SSH_ASKPASS：{error}"))?;
        command.args(["-o", "BatchMode=no", "-o", "PreferredAuthentications=password,keyboard-interactive", "-o", "PubkeyAuthentication=no", "-o", "NumberOfPasswordPrompts=1"]);
        command.env("SSH_ASKPASS", executable);
        command.env("SSH_ASKPASS_REQUIRE", "force");
        command.env("TERMIO_ASKPASS_PASSWORD", password);
        #[cfg(unix)]
        command.env("DISPLAY", "termio:0");
    }
    // SSH Config mode intentionally leaves the default OpenSSH config enabled.
    // Interactive terminals may therefore use configured keys, agents, jumps or passphrases.
    #[cfg(unix)]
    command.args(["-o", "ControlMaster=auto", "-o", "ControlPersist=600", "-o", "ControlPath=/tmp/termio-%C"]);
    if server.auth_method == "password" {
        command.args(["-p", &server.port.to_string(), &format!("{}@{}", server.username, server.host)]);
    } else {
        command.arg(&server.host);
    }
    Ok(command)
}

#[cfg(test)]
mod tests {
    #[test]
    fn gpu_terminal_starts_with_a_fixed_export() {
        let command = format!("export CUDA_VISIBLE_DEVICES={}; exec \"${{SHELL:-/bin/sh}}\" -l", 3);
        assert_eq!(command, "export CUDA_VISIBLE_DEVICES=3; exec \"${SHELL:-/bin/sh}\" -l");
    }
}
