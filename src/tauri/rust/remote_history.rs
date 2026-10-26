use crate::{
    collector::{classify_ssh_error, configured_ssh_command_without_control},
    models::Server,
};
use std::process::Stdio;
use tokio::time::{timeout, Duration};

// Legacy cleanup only: current Termio versions no longer install or synchronize
// remote history. This removes leftovers created by older versions.
const LEGACY_REMOTE_REMOVE_SCRIPT: &str = r#"set -eu
state=$HOME/.termio
if [ -r "$state/.daemon.pid" ]; then
  pid="$(cat "$state/.daemon.pid" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o args= 2>/dev/null | grep -F "$state/.daemon.sh" >/dev/null 2>&1; then
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  fi
fi
rm -rf -- "$state"
printf '__TERMIO_LEGACY_CLEANUP_DONE__\n'
"#;

pub async fn remove(server: &Server, password: Option<&str>) -> Result<(), String> {
    let output = run_remote_cleanup_command(server, password, LEGACY_REMOTE_REMOVE_SCRIPT, Duration::from_secs(8)).await?;
    if !output.lines().any(|line| line.trim() == "__TERMIO_LEGACY_CLEANUP_DONE__") {
        return Err("远端遗留数据清理后未返回确认标记".into());
    }
    Ok(())
}

async fn run_remote_cleanup_command(server: &Server, password: Option<&str>, script: &str, duration: Duration) -> Result<String, String> {
    let (mut command, target) = configured_ssh_command_without_control(server, password)?;
    command.arg(target).arg(script).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let output = timeout(duration, command.output()).await
        .map_err(|_| format!("连接 {} 清理远端遗留数据超时", server.name))?
        .map_err(|error| format!("无法启动系统 ssh：{error}"))?;
    if !output.status.success() {
        return Err(classify_ssh_error(String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_script_only_removes_legacy_termio_state() {
        assert!(LEGACY_REMOTE_REMOVE_SCRIPT.contains("$HOME/.termio"));
    }
}
