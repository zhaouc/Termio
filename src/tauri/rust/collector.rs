use crate::models::{CpuProcessMetric, DiskMetric, GpuMetric, NetworkMetric, NetworkUserMetric, ProcessMetric, Server, Snapshot, SystemMetric};
use std::{collections::{HashMap, HashSet}, process::Stdio, time::{SystemTime, UNIX_EPOCH}};
use tokio::{process::Command, time::{timeout, Duration}};

const REMOTE_SCRIPT: &str = r#"export LANG=C LC_ALL=C;
printf '__TERMIO_USER__\n'; id -un;
uid_min="$(awk '$1 == "UID_MIN" { print $2; exit }' /etc/login.defs 2>/dev/null)"; uid_min="${uid_min:-1000}";
printf '__TERMIO_UIDMIN__\n%s\n' "$uid_min";
printf '__TERMIO_HOST__\n'; hostname;
printf '__TERMIO_OS__\n'; if [ -r /etc/os-release ]; then . /etc/os-release; printf '%s|%s\n' "${ID:-unknown}" "${PRETTY_NAME:-Linux}"; else printf 'unknown|Linux\n'; fi;
printf '__TERMIO_CPUMODEL__\n'; if command -v lscpu >/dev/null 2>&1; then lscpu | awk -F: '/^Model name:/ {sub(/^[[:space:]]+/, "", $2); print $2; exit}'; else awk -F: '/^model name[[:space:]]*:/ {sub(/^[[:space:]]+/, "", $2); print $2; exit}' /proc/cpuinfo; fi;
network_ifaces="$(ip route show default 2>/dev/null | awk '{for (i=1; i<=NF; i++) if ($i == "dev" && (i+1) <= NF) print $(i+1)}' | sort -u | paste -sd' ' -)";
termio_net_total() {
  awk -v allowed="$network_ifaces" 'BEGIN { has=(allowed != ""); n=split(allowed, list, " "); for (i=1; i<=n; i++) if (list[i] != "") keep[list[i]]=1 }
    NR > 2 { iface=$1; sub(/:$/, "", iface); if (iface == "lo") next; if (has && !(iface in keep)) next; rx+=$2; tx+=$10 }
    END { printf "%.0f|%.0f\n", rx+0, tx+0 }' /proc/net/dev 2>/dev/null;
}
net_socket_supported=0; net_sock1=""; net_sock2="";
if command -v ss >/dev/null 2>&1; then
  net_socket_supported=1;
  if [ "${TERMIO_INCLUDE_PROCESSES:-1}" = "1" ]; then net_sock1="$(ss -tineH -O state established 2>/dev/null | head -n 2048 || true)"; fi;
fi;
net_total1="$(termio_net_total)";
net_time1="$(awk '{print $1}' /proc/uptime 2>/dev/null)";
printf '__TERMIO_CPU1__\n'; head -n 1 /proc/stat;
sleep 0.25;
printf '__TERMIO_CPU2__\n'; head -n 1 /proc/stat;
net_time2="$(awk '{print $1}' /proc/uptime 2>/dev/null)";
net_total2="$(termio_net_total)";
if [ "$net_socket_supported" = "1" ] && [ "${TERMIO_INCLUDE_PROCESSES:-1}" = "1" ]; then net_sock2="$(ss -tineH -O state established 2>/dev/null | head -n 2048 || true)"; fi;
printf '__TERMIO_NETTIME1__\n%s\n' "$net_time1";
printf '__TERMIO_NETTIME2__\n%s\n' "$net_time2";
printf '__TERMIO_NET1__\n%s\n' "$net_total1";
printf '__TERMIO_NET2__\n%s\n' "$net_total2";
printf '__TERMIO_NETUSER_SUPPORTED__\n%s\n' "$net_socket_supported";
if [ "$net_socket_supported" = "1" ] && [ "${TERMIO_INCLUDE_PROCESSES:-1}" = "1" ]; then
  printf '__TERMIO_NETSOCK1__\n%s\n' "$net_sock1";
  printf '__TERMIO_NETSOCK2__\n%s\n' "$net_sock2";
  # ss may omit uid: for sockets owned by other users. Read the kernel's
  # inode-to-UID mapping instead of incorrectly treating missing UID as root.
  socket_inodes="$(printf '%s\n%s\n' "$net_sock1" "$net_sock2" | grep -o 'ino:[0-9][0-9]*' | cut -d: -f2 | sort -nu | head -n 4096)";
  socket_owners="";
  if [ -n "$socket_inodes" ]; then
    socket_owners="$(awk -v wanted="$socket_inodes" 'BEGIN { n=split(wanted, list, "\n"); for (i=1; i<=n; i++) if (list[i] != "") selected[list[i]]=1 }
      FNR > 1 && ($10 in selected) && $8 ~ /^[0-9]+$/ { print $10 "|" $8 }' /proc/net/tcp /proc/net/tcp6 2>/dev/null | sort -u)";
  fi;
  printf '__TERMIO_NETSOCKOWNERS__\n%s\n' "$socket_owners";
  printf '__TERMIO_UIDMAP__\n';
  { printf '%s\n%s\n' "$net_sock1" "$net_sock2" | grep -o 'uid:[0-9][0-9]*' | cut -d: -f2;
    printf '%s\n' "$socket_owners" | cut -d'|' -f2; } | grep -E '^[0-9]+$' | sort -nu | head -n 64 | while read -r net_uid; do
    [ -z "$net_uid" ] && continue;
    net_name="$(getent passwd "$net_uid" 2>/dev/null | cut -d: -f1 | head -n 1)";
    [ -z "$net_name" ] && net_name="uid-$net_uid";
    printf '%s|%s\n' "$net_uid" "$net_name";
  done;
fi;
printf '__TERMIO_LOAD__\n'; cat /proc/loadavg;
printf '__TERMIO_MEM__\n'; grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo;
if [ "${TERMIO_INCLUDE_DISKS:-1}" = "1" ]; then
  printf '__TERMIO_DISK__\n';
  current_user="$(id -un)";
  home_mount="$(df -P -k "$HOME" 2>/dev/null | awk 'NR == 2 {print $6}')";
  home_used="$(du -skx "$HOME" 2>/dev/null | awk '{print $1; exit}')"; home_used="${home_used:-0}";
  df -P -k -x tmpfs -x devtmpfs 2>/dev/null | awk 'NR > 1 && $2 ~ /^[0-9]+$/ { print $6 "|" $3 "|" $2 "|" $4 }' | while IFS='|' read -r mount used total available; do
    case "$mount" in /sys|/sys/*|/proc|/proc/*|/dev|/dev/*|/run|/run/*|/boot/efi|/boot/efi/*|/snap/*|/var/lib/docker/*|/var/lib/containers/*|/var/lib/kubelet/*) continue ;; esac
    own=0;
    if [ "$mount" = "$home_mount" ]; then own="$home_used";
    else
      for candidate in "$mount/$current_user" "$mount/home/$current_user"; do
        if [ -d "$candidate" ]; then own="$(du -skx "$candidate" 2>/dev/null | awk '{print $1; exit}')"; own="${own:-0}"; break; fi;
      done;
    fi;
    [ "$own" -gt "$used" ] 2>/dev/null && own="$used";
    printf '%s|%s|%s|%s|%s\n' "$mount" "$used" "$total" "$available" "$own";
  done | head -n 16;
fi;
printf '__TERMIO_USERCPU__\n'; ps -u "$(id -un)" -o pcpu= 2>/dev/null | awk -v n="$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf 1)" '{s+=$1} END { if (n > 0) printf "%.2f\n", s/n; else printf "%.2f\n", s+0 }';
printf '__TERMIO_ACCELERATOR__\n';
if command -v nvidia-smi >/dev/null 2>&1; then printf 'nvidia\n'; elif command -v npu-smi >/dev/null 2>&1; then printf 'ascend\n'; else printf 'nvidia\n'; fi;
printf '__TERMIO_NVIDIA__\n';
if ! command -v nvidia-smi >/dev/null 2>&1 && command -v npu-smi >/dev/null 2>&1; then
  ascend_info="$(npu-smi info 2>&1)"; ascend_status=$?;
  if [ "$ascend_status" -eq 0 ]; then
    printf 'available\n';
    printf '__TERMIO_GPU__\n';
    printf '%s\n' "$ascend_info" | awk -F '|' '
      function trim(value) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); return value }
      /^\|/ {
        for (i=2; i<NF; i++) field[i]=trim($i)
        if (field[2] ~ /^[0-9]+$/ && field[4] ~ /^(OK|Warning|Alarm|Failure)$/) {
          device=field[2]; name=field[3]; power=field[5]+0; temperature=field[6]+0; next
        }
        if (device != "" && field[2] ~ /^[0-9]+$/ && field[3] ~ /^[0-9]+$/ && field[4] ~ /:/) {
          split(field[7], memory, "/"); used=trim(memory[1])+0; total=trim(memory[2])+0;
          memory_percent=(total > 0 ? used/total*100 : 0);
          printf "%s, Ascend %s, NPU-%s-%s, %.2f, %.2f, %.2f, %.2f, %.2f, %.2f\n", device, name, device, field[2], field[5]+0, memory_percent, used, total, temperature, power
        }
      }';
  elif printf '%s\n' "$ascend_info" | grep -qi 'permission denied'; then printf 'permissionDenied\n%s\n' "$ascend_info";
  else printf 'failed\n%s\n' "$ascend_info"; fi;
elif ! command -v nvidia-smi >/dev/null 2>&1; then
  printf 'missing\n';
else
  nvidia_list="$(nvidia-smi -L 2>&1)"; nvidia_status=$?;
  if [ "$nvidia_status" -eq 0 ]; then nvidia_state=available;
  elif printf '%s\n' "$nvidia_list" | grep -q '^GPU [0-9][0-9]*:'; then nvidia_state=degraded;
  elif printf '%s\n' "$nvidia_list" | grep -qi 'permission denied'; then nvidia_state=permissionDenied;
  else nvidia_state=failed; fi;
  printf '%s\n' "$nvidia_state";
  if [ "$nvidia_state" != available ]; then printf '%s\n' "$nvidia_list"; fi;
  if [ "$nvidia_state" = available ] || [ "$nvidia_state" = degraded ]; then
    printf '__TERMIO_GPU__\n';
    if [ "$nvidia_state" = available ]; then
      nvidia-smi --query-gpu=index,name,uuid,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>/dev/null || true;
    else
      printf '%s\n' "$nvidia_list" | sed -n 's/^GPU \([0-9][0-9]*\):.*/\1/p' | while read -r gpu_index; do
        nvidia-smi -i "$gpu_index" --query-gpu=index,name,uuid,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>/dev/null || true;
      done;
      printf '%s\n' "$nvidia_list" | awk '
        /^GPU [0-9][0-9]*:/ {
          value=$0; sub(/^GPU /, "", value); sub(/:.*/, "", value); next_index=value+1; next
        }
        /Unable to determine the device handle for gpu / {
          match($0, /gpu [0-9A-Fa-f:.]+/); bus=substr($0, RSTART+4, RLENGTH-4); sub(/:$/, "", bus);
          uuid=bus; gsub(/[^0-9A-Za-z]/, "_", uuid);
          printf "%d, Unavailable GPU (%s), unavailable-%s, 0, 0, 0, 0, 0, 0\n", next_index, bus, uuid; next_index++
        }';
    fi;
  fi;
fi;
if [ "${TERMIO_INCLUDE_PROCESSES:-1}" = "1" ]; then
  printf '__TERMIO_GPUPROC__\n';
  gpu_proc="";
  if command -v nvidia-smi >/dev/null 2>&1; then
    query_gpu_processes() {
      selector="$1";
      if nvidia_smi_processes="$(nvidia-smi $selector --query-compute-apps=gpu_uuid,pid,process_name,used_gpu_memory --format=csv,noheader,nounits 2>/dev/null)"; then
        printf '%s\n' "$nvidia_smi_processes"; return 0;
      fi;
      if nvidia_smi_processes="$(nvidia-smi $selector --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null)"; then
        printf '%s\n' "$nvidia_smi_processes"; return 0;
      fi;
      return 1;
    }
    if ! gpu_proc="$(query_gpu_processes '')"; then
      gpu_proc="$(printf '%s\n' "$nvidia_list" | sed -n 's/^GPU \([0-9][0-9]*\):.*/\1/p' | while read -r gpu_index; do query_gpu_processes "-i $gpu_index" || true; done)";
    fi;
    printf '%s\n' "$gpu_proc";
  elif command -v npu-smi >/dev/null 2>&1; then
    gpu_proc="$(npu-smi info 2>/dev/null | awk -F '|' '
      function trim(value) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); return value }
      /^\|/ { for (i=2; i<NF; i++) field[i]=trim($i); if (field[2] ~ /^[0-9]+$/ && field[4] ~ /^(OK|Warning|Alarm|Failure)$/) print field[2] }
    ' | sort -nu | while read -r npu_index; do
      npu-smi info -t proc-mem -i "$npu_index" 2>/dev/null | awk -F '|' '
        function trim(value) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); return value }
        /^\|/ { for (i=2; i<NF; i++) field[i]=trim($i); if (field[2] ~ /^[0-9]+$/ && field[3] ~ /^[0-9]+$/ && field[4] ~ /^[0-9]+$/) printf "NPU-%s-%s, %s, %s, %.2f\n", field[2], field[3], field[4], field[5], field[6]+0 }
      '
    done)";
    printf '%s\n' "$gpu_proc";
  fi;
  printf '__TERMIO_GPUPMON__\n';
  if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi pmon -c 1 -s um 2>/dev/null || true; fi;
  printf '__TERMIO_PS__\n';
  gpu_pids="$(printf '%s\n' "$gpu_proc" | cut -d, -f2 | tr -d ' ' | paste -sd, -)";
  ps -eo user:64=,uid=,pid=,ppid=,pgid=,pcpu=,pmem=,rss=,etime=,args= --sort=-pcpu 2>/dev/null | awk -v gpu_pids="$gpu_pids" -v uid_min="$uid_min" 'BEGIN { n=split(gpu_pids, ids, ","); for (i=1; i<=n; i++) if (ids[i] != "") gpu[ids[i]]=1 } { is_gpu=($3 in gpu); is_child=($4 in gpu); is_user=($2 >= uid_min); is_main=($3 == $5 && $6 > 0); has_memory=($8 > 1048576); if (is_gpu || (is_user && has_memory && (is_child || (is_main && main_count < 64)))) { print; if (!is_gpu && is_main && !is_child) main_count++ } }' || true;
fi;
printf '__TERMIO_END__\n';"#;

pub async fn collect(server: &Server) -> Result<Snapshot, String> {
    collect_with_password(server, None, true, true).await
}

pub async fn collect_with_password(server: &Server, password: Option<&str>, include_processes: bool, include_disks: bool) -> Result<Snapshot, String> {
    collect_with_password_detailed(server, password, include_processes, include_disks).await.map(|result| result.snapshot)
}

pub struct CollectionResult {
    pub snapshot: Snapshot,
    pub response_bytes: u64,
}

pub async fn collect_with_password_detailed(server: &Server, password: Option<&str>, include_processes: bool, include_disks: bool) -> Result<CollectionResult, String> {
    let (mut command, target) = configured_ssh_command(server, password)?;
    command.arg(target).arg(format!(
        "TERMIO_INCLUDE_PROCESSES={} TERMIO_INCLUDE_DISKS={};{REMOTE_SCRIPT}",
        if include_processes { 1 } else { 0 },
        if include_disks { 1 } else { 0 },
    )).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let output = timeout(Duration::from_secs(30), command.output()).await.map_err(|_| format!("连接 {} 超时（30 秒）", server.name))?.map_err(|error| format!("无法启动系统 ssh：{error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(classify_ssh_error(&stderr));
    }
    let snapshot = parse_snapshot(&server.id, &String::from_utf8_lossy(&output.stdout))?;
    Ok(CollectionResult { snapshot, response_bytes: output.stdout.len() as u64 })
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

pub fn collection_display_command(server: &Server, include_processes: bool, include_disks: bool) -> String {
    let mut arguments = vec![
        "-o ConnectTimeout=8".to_string(),
        "-o ServerAliveInterval=5".to_string(),
        "-o ServerAliveCountMax=2".to_string(),
        "-o StrictHostKeyChecking=yes".to_string(),
    ];
    if server.auth_method == "password" {
        arguments.insert(0, format!("-F {}", shell_quote(if cfg!(windows) { "NUL" } else { "/dev/null" })));
        arguments.extend([
            "-o BatchMode=no".to_string(),
            "-o PreferredAuthentications=password,keyboard-interactive".to_string(),
            "-o PubkeyAuthentication=no".to_string(),
            "-o NumberOfPasswordPrompts=1".to_string(),
        ]);
    } else {
        arguments.push("-o BatchMode=yes".to_string());
    }
    let target = if server.auth_method == "password" {
        arguments.push(format!("-p {}", server.port));
        format!("{}@{}", server.username, server.host)
    } else {
        server.host.clone()
    };
    let remote_command = format!(
        "TERMIO_INCLUDE_PROCESSES={} TERMIO_INCLUDE_DISKS={};{REMOTE_SCRIPT}",
        if include_processes { 1 } else { 0 },
        if include_disks { 1 } else { 0 },
    );
    format!("ssh {} {} {}", arguments.join(" "), shell_quote(&target), shell_quote(&remote_command))
}

pub(crate) fn configured_ssh_command(server: &Server, password: Option<&str>) -> Result<(Command, String), String> {
    configured_ssh_command_with_control_mode(server, password, false)
}

pub(crate) fn configured_ssh_command_without_control(server: &Server, password: Option<&str>) -> Result<(Command, String), String> {
    configured_ssh_command_with_control_mode(server, password, false)
}

pub(crate) fn configured_shared_ssh_command(server: &Server, password: Option<&str>) -> Result<(Command, String), String> {
    configured_ssh_command_with_control_mode(server, password, true)
}

fn configured_ssh_command_with_control_mode(server: &Server, password: Option<&str>, use_control_master: bool) -> Result<(Command, String), String> {
    // OpenSSH ControlMaster options are only configured on Unix.
    #[cfg(windows)]
    let _ = use_control_master;
    let mut command = Command::new("ssh");
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command.args(["-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2", "-o", "StrictHostKeyChecking=yes"]);
    if server.auth_method == "password" {
        command.arg("-F").arg(if cfg!(windows) { "NUL" } else { "/dev/null" });
        let password = password.ok_or("没有可用密码；请重新编辑服务器并输入密码")?;
        let executable = std::env::current_exe().map_err(|error| format!("无法定位 Termio SSH_ASKPASS：{error}"))?;
        command
            .args(["-o", "BatchMode=no", "-o", "PreferredAuthentications=password,keyboard-interactive", "-o", "PubkeyAuthentication=no", "-o", "NumberOfPasswordPrompts=1"])
            .env("SSH_ASKPASS", executable)
            .env("SSH_ASKPASS_REQUIRE", "force")
            .env("TERMIO_ASKPASS_PASSWORD", password);
        #[cfg(unix)]
        command.env("DISPLAY", "termio:0");
    } else {
        // SSH Config authentication intentionally uses the user's default OpenSSH
        // configuration. Host aliases, IdentityFile, ProxyJump and SSH Agent are
        // resolved by the system ssh client. Background operations remain non-interactive.
        command.args(["-o", "BatchMode=yes"]);
    }
    #[cfg(unix)]
    if use_control_master {
        command.args(["-o", "ControlMaster=auto", "-o", "ControlPersist=600", "-o", "ControlPath=/tmp/termio-%C"]);
    } else {
        command.args(["-o", "ControlMaster=no", "-o", "ControlPath=none"]);
    }
    let target = if server.auth_method == "password" {
        command.args(["-p", &server.port.to_string()]);
        format!("{}@{}", server.username, server.host)
    } else {
        server.host.clone()
    };
    Ok((command, target))
}

pub async fn install_nvidia_driver(server: &Server, password: Option<&str>) -> Result<String, String> {
    let (mut detect, target) = configured_ssh_command(server, password)?;
    detect.arg(&target).arg("if [ -r /etc/os-release ]; then . /etc/os-release; printf '%s' \"${ID:-unknown}\"; else printf unknown; fi").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let detected = timeout(Duration::from_secs(10), detect.output()).await.map_err(|_| "识别 Linux 发行版超时".to_string())?.map_err(|error| format!("无法启动系统 ssh：{error}"))?;
    if !detected.status.success() { return Err(classify_ssh_error(String::from_utf8_lossy(&detected.stderr).trim())); }
    let os_id = String::from_utf8_lossy(&detected.stdout).trim().to_ascii_lowercase();
    let install_script = match os_id.as_str() {
        "ubuntu" => "sudo -n sh -c 'apt-get update && apt-get install -y ubuntu-drivers-common && ubuntu-drivers autoinstall'",
        "debian" => "sudo -n sh -c 'apt-get update && apt-get install -y nvidia-driver'",
        _ => return Err(format!("暂不支持在 {os_id} 上自动安装。请复制界面提供的命令或参考 NVIDIA 官方文档。")),
    };
    let (mut install, target) = configured_ssh_command(server, password)?;
    install.arg(target).arg(install_script).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let output = timeout(Duration::from_secs(900), install.output()).await.map_err(|_| "NVIDIA 驱动安装超过 15 分钟，已停止等待；请登录服务器检查安装状态".to_string())?.map_err(|error| format!("无法启动系统 ssh：{error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.to_ascii_lowercase().contains("password is required") || stderr.to_ascii_lowercase().contains("a password is required") {
            return Err("服务器需要交互式 sudo 密码。Termio 不会代填管理员密码；请复制安装命令并在终端执行。".into());
        }
        return Err(format!("驱动安装失败：{stderr}"));
    }
    Ok("安装命令执行完成。驱动通常需要重启服务器后生效；请重启后点击“重新检测”。".into())
}

pub(crate) fn classify_ssh_error(stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    if lower.contains("host key verification failed") || lower.contains("no host key is known") {
        "主机指纹尚未信任或已发生变化。为防止中间人攻击，Termio 已阻止连接；请先用系统 ssh 核对并接受指纹。".into()
    } else if lower.contains("permission denied") {
        format!("SSH 认证失败：{stderr}")
    } else if lower.contains("connection refused") {
        format!("SSH 连接被拒绝：{stderr}")
    } else if lower.contains("connection closed by 127.0.0.1") || lower.contains("connect to host 127.0.0.1") {
        format!("SSH 连接被本机网络组件拒绝：{stderr}")
    } else if lower.contains("no route to host") || lower.contains("operation timed out") {
        format!("服务器不可达：{stderr}")
    } else if stderr.is_empty() {
        "SSH 命令执行失败，未返回错误详情".into()
    } else {
        format!("SSH 连接失败：{stderr}")
    }
}

pub fn parse_snapshot(server_id: &str, output: &str) -> Result<Snapshot, String> {
    let sections = split_sections(output);
    let username = first_line(&sections, "USER").unwrap_or("unknown").to_string();
    let uid_min = first_line(&sections, "UIDMIN").and_then(|value| value.parse::<u32>().ok()).unwrap_or(1000);
    let hostname = first_line(&sections, "HOST").unwrap_or("unknown").to_string();
    let os = first_line(&sections, "OS").unwrap_or("unknown|Linux");
    let (os_id, os_name) = os.split_once('|').unwrap_or(("unknown", "Linux"));
    let cpu_model = first_line(&sections, "CPUMODEL").unwrap_or("未知 CPU").to_string();
    let cpu1 = parse_cpu(first_line(&sections, "CPU1").ok_or("采集输出缺少 /proc/stat 首次样本")?)?;
    let cpu2 = parse_cpu(first_line(&sections, "CPU2").ok_or("采集输出缺少 /proc/stat 第二次样本")?)?;
    let cpu_delta = cpu2.0.saturating_sub(cpu1.0);
    let idle_delta = cpu2.1.saturating_sub(cpu1.1);
    let cpu_utilization = if cpu_delta > 0 { (1.0 - idle_delta as f64 / cpu_delta as f64) * 100.0 } else { 0.0 };
    let mut system = SystemMetric { cpu_model, cpu_utilization: cpu_utilization.clamp(0.0, 100.0), ..Default::default() };
    if let Some(load) = first_line(&sections, "LOAD") {
        let values: Vec<f64> = load.split_whitespace().take(3).map(parse_number).collect();
        if values.len() == 3 { system.load1 = values[0]; system.load5 = values[1]; system.load15 = values[2]; }
    }
    if let Some(memory) = sections.get("MEM") { parse_memory(memory, &mut system); }
    system.current_user_cpu_utilization = first_line(&sections, "USERCPU").map(parse_number).unwrap_or_default();
    let disks = sections.get("DISK").map(|lines| lines.iter().filter_map(|line| parse_disk(line).ok()).collect()).unwrap_or_default();
    let network = parse_network(&sections);

    let accelerator_vendor = first_line(&sections, "ACCELERATOR").filter(|value| *value == "ascend").unwrap_or("nvidia").to_string();
    let nvidia_lines = sections.get("NVIDIA").cloned().unwrap_or_default();
    let nvidia_smi = nvidia_lines.first().map(String::as_str).unwrap_or("missing").to_string();
    let nvidia_message = match nvidia_smi.as_str() {
        "available" => None,
        "missing" => Some("服务器未检测到 nvidia-smi 或 npu-smi；可能没有受支持的加速卡，或驱动工具未安装/不在 PATH 中。".into()),
        _ => Some(nvidia_lines.iter().skip(1).cloned().collect::<Vec<_>>().join("\n").trim().to_string()).filter(|value| !value.is_empty()).or_else(|| Some("nvidia-smi 存在但无法执行，请检查驱动和权限。".into())),
    };
    let gpus: Vec<GpuMetric> = sections
        .get("GPU")
        .map(|lines| lines.iter().filter_map(|line| parse_gpu(line).ok()).collect::<Vec<_>>())
        .unwrap_or_default();
    let ps = parse_ps(sections.get("PS"));
    let pmon = parse_pmon(sections.get("GPUPMON"));
    let processes = parse_gpu_processes(sections.get("GPUPROC"), &gpus, &ps, &pmon, &username);
    let cpu_processes = parse_cpu_processes(&ps, &processes, &username, uid_min);
    let processes_sampled = sections.contains_key("GPUPROC");
    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_secs() as i64;
    Ok(Snapshot { server_id: server_id.into(), hostname, username, os_id: os_id.into(), os_name: os_name.into(), timestamp, status: if nvidia_smi == "available" { "online".into() } else { "warning".into() }, accelerator_vendor, system, network, gpus, disks, processes, cpu_processes, processes_sampled, nvidia_smi, nvidia_message })
}

#[derive(Debug, Clone, Copy, Default)]
struct SocketCounter {
    uid: u32,
    sent_bytes: u64,
    received_bytes: u64,
}

fn parse_prefixed_u64(line: &str, prefix: &str) -> Option<u64> {
    line.split_whitespace().find_map(|token| token.strip_prefix(prefix)?.trim_end_matches(',').parse().ok())
}

fn is_loopback_socket_line(line: &str) -> bool {
    line.contains("127.0.0.1:") || line.contains("[::1]:")
}

fn parse_socket_counters(lines: Option<&Vec<String>>, inode_owners: &HashMap<u64, u32>) -> HashMap<u64, SocketCounter> {
    let mut result = HashMap::new();
    let mut current_inode: Option<u64> = None;
    let mut current_uid: Option<u32> = None;
    for line in lines.into_iter().flatten() {
        if is_loopback_socket_line(line) {
            current_inode = None;
            current_uid = None;
            continue;
        }
        if let Some(inode) = parse_prefixed_u64(line, "ino:") {
            current_inode = Some(inode);
            current_uid = None;
        }
        if let Some(uid) = parse_prefixed_u64(line, "uid:").and_then(|value| u32::try_from(value).ok()) { current_uid = Some(uid); }
        let sent = parse_prefixed_u64(line, "bytes_sent:").or_else(|| parse_prefixed_u64(line, "bytes_acked:"));
        let received = parse_prefixed_u64(line, "bytes_received:");
        if let Some(inode) = current_inode {
            // Prefer the explicit ss UID; /proc/net/tcp{,6} supplies one when
            // ss does not report it. Never guess root for an unknown owner.
            if let Some(uid) = current_uid.or_else(|| inode_owners.get(&inode).copied()) {
                if sent.is_some() || received.is_some() {
                    result.insert(inode, SocketCounter { uid, sent_bytes: sent.unwrap_or_default(), received_bytes: received.unwrap_or_default() });
                }
            }
        }
    }
    result
}

fn parse_network_total(line: Option<&str>) -> (u64, u64) {
    let Some(line) = line else { return (0, 0) };
    let Some((rx, tx)) = line.split_once('|') else { return (0, 0) };
    (rx.trim().parse().unwrap_or(0), tx.trim().parse().unwrap_or(0))
}

fn parse_network(sections: &HashMap<String, Vec<String>>) -> NetworkMetric {
    let time1 = first_line(sections, "NETTIME1").map(parse_number).unwrap_or_default();
    let time2 = first_line(sections, "NETTIME2").map(parse_number).unwrap_or_default();
    let measured_elapsed = time2 - time1;
    let elapsed = if (0.05..=5.0).contains(&measured_elapsed) { measured_elapsed } else { 0.25 };
    let (rx1, tx1) = parse_network_total(first_line(sections, "NET1"));
    let (rx2, tx2) = parse_network_total(first_line(sections, "NET2"));
    let download_bytes_per_second = rx2.saturating_sub(rx1) as f64 / elapsed;
    let upload_bytes_per_second = tx2.saturating_sub(tx1) as f64 / elapsed;
    let mut user_breakdown_supported = first_line(sections, "NETUSER_SUPPORTED") == Some("1");
    let users_sampled = sections.contains_key("NETSOCK1") && sections.contains_key("NETSOCK2");
    if !users_sampled {
        return NetworkMetric { download_bytes_per_second, upload_bytes_per_second, users: Vec::new(), user_breakdown_supported, users_sampled };
    }

    let inode_owners: HashMap<u64, u32> = sections.get("NETSOCKOWNERS").into_iter().flatten().filter_map(|line| {
        let (inode, uid) = line.split_once('|')?;
        Some((inode.parse().ok()?, uid.parse().ok()?))
    }).collect();
    let before = parse_socket_counters(sections.get("NETSOCK1"), &inode_owners);
    let after = parse_socket_counters(sections.get("NETSOCK2"), &inode_owners);
    let has_socket_rows = sections.get("NETSOCK1").into_iter().flatten().chain(sections.get("NETSOCK2").into_iter().flatten()).any(|line| !is_loopback_socket_line(line));
    if has_socket_rows && before.is_empty() && after.is_empty() { user_breakdown_supported = false; }
    let uid_names: HashMap<u32, String> = sections.get("UIDMAP").into_iter().flatten().filter_map(|line| {
        let (uid, name) = line.split_once('|')?;
        Some((uid.parse().ok()?, name.to_string()))
    }).collect();
    let mut totals: HashMap<u32, (u64, u64, u32)> = HashMap::new();
    for (inode, current) in after {
        let Some(previous) = before.get(&inode) else { continue };
        if previous.uid != current.uid { continue; }
        let entry = totals.entry(current.uid).or_default();
        entry.0 = entry.0.saturating_add(current.received_bytes.saturating_sub(previous.received_bytes));
        entry.1 = entry.1.saturating_add(current.sent_bytes.saturating_sub(previous.sent_bytes));
        entry.2 = entry.2.saturating_add(1);
    }
    let mut users: Vec<_> = totals.into_iter().filter_map(|(uid, (received, sent, connection_count))| {
        if received == 0 && sent == 0 { return None; }
        Some(NetworkUserMetric {
            uid,
            username: uid_names.get(&uid).cloned().unwrap_or_else(|| format!("uid-{uid}")),
            download_bytes_per_second: received as f64 / elapsed,
            upload_bytes_per_second: sent as f64 / elapsed,
            connection_count,
        })
    }).collect();
    users.sort_by(|left, right| {
        let left_total = left.download_bytes_per_second + left.upload_bytes_per_second;
        let right_total = right.download_bytes_per_second + right.upload_bytes_per_second;
        right_total.total_cmp(&left_total).then_with(|| left.username.cmp(&right.username))
    });
    users.truncate(24);
    NetworkMetric { download_bytes_per_second, upload_bytes_per_second, users, user_breakdown_supported, users_sampled }
}

fn parse_disk(line: &str) -> Result<DiskMetric, String> {
    let fields: Vec<&str> = line.split('|').collect();
    if !(4..=5).contains(&fields.len()) || !is_visible_disk_mount(fields[0]) { return Err("磁盘采样记录无效".into()); }
    let used_kb = fields[1].parse::<u64>().map_err(|_| "磁盘已用空间无效".to_string())?;
    let total_kb = fields[2].parse::<u64>().map_err(|_| "磁盘总空间无效".to_string())?;
    let available_kb = fields[3].parse::<u64>().map_err(|_| "磁盘可用空间无效".to_string())?;
    if total_kb == 0 || used_kb > total_kb { return Err("磁盘容量范围无效".into()); }
    let current_user_used_kb = fields.get(4).and_then(|value| value.parse::<u64>().ok()).unwrap_or_default().min(used_kb);
    Ok(DiskMetric { mount_point: fields[0].to_string(), used_bytes: used_kb.saturating_mul(1024), total_bytes: total_kb.saturating_mul(1024), available_bytes: available_kb.saturating_mul(1024), current_user_used_bytes: current_user_used_kb.saturating_mul(1024) })
}

fn is_visible_disk_mount(mount: &str) -> bool {
    !["/sys", "/proc", "/dev", "/run", "/boot/efi", "/snap", "/var/lib/docker", "/var/lib/containers", "/var/lib/kubelet"]
        .iter()
        .any(|prefix| mount == *prefix || mount.starts_with(&format!("{prefix}/")))
}

fn split_sections(output: &str) -> HashMap<String, Vec<String>> {
    let mut sections: HashMap<String, Vec<String>> = HashMap::new();
    let mut current: Option<String> = None;
    for raw_line in output.lines() {
        let line = raw_line.trim_end();
        if let Some(name) = line.strip_prefix("__TERMIO_").and_then(|value| value.strip_suffix("__")) {
            if name == "END" { current = None; } else { current = Some(name.to_string()); sections.entry(name.to_string()).or_default(); }
        } else if let Some(section) = current.as_ref() {
            if !line.trim().is_empty() { sections.entry(section.clone()).or_default().push(line.trim().to_string()); }
        }
    }
    sections
}

fn first_line<'a>(sections: &'a HashMap<String, Vec<String>>, key: &str) -> Option<&'a str> { sections.get(key)?.first().map(String::as_str) }
fn parse_number(value: &str) -> f64 { value.trim().parse().unwrap_or(0.0) }

fn parse_cpu(line: &str) -> Result<(u64, u64), String> {
    let values: Vec<u64> = line.split_whitespace().skip(1).map(|value| value.parse().unwrap_or(0)).collect();
    if values.len() < 4 { return Err(format!("无效的 /proc/stat 输出：{line}")); }
    let total = values.iter().sum();
    let idle = values.get(3).copied().unwrap_or(0) + values.get(4).copied().unwrap_or(0);
    Ok((total, idle))
}

fn parse_memory(lines: &[String], system: &mut SystemMetric) {
    let mut values = HashMap::new();
    for line in lines {
        let mut parts = line.split_whitespace();
        if let (Some(key), Some(value)) = (parts.next(), parts.next()) { values.insert(key.trim_end_matches(':'), value.parse::<u64>().unwrap_or(0) * 1024); }
    }
    system.memory_total_bytes = *values.get("MemTotal").unwrap_or(&0);
    let available = *values.get("MemAvailable").unwrap_or(&0);
    system.memory_used_bytes = system.memory_total_bytes.saturating_sub(available);
    system.swap_total_bytes = *values.get("SwapTotal").unwrap_or(&0);
    system.swap_used_bytes = system.swap_total_bytes.saturating_sub(*values.get("SwapFree").unwrap_or(&0));
}

fn parse_gpu(line: &str) -> Result<GpuMetric, String> {
    let fields: Vec<&str> = line.split(',').map(str::trim).collect();
    if fields.len() < 9 { return Err(format!("无效的 nvidia-smi GPU 输出：{line}")); }
    Ok(GpuMetric { index: fields[0].parse().map_err(|_| format!("无效 GPU 索引：{}", fields[0]))?, name: fields[1].into(), uuid: fields[2].into(), utilization: parse_number(fields[3]).clamp(0.0, 100.0), memory_utilization: parse_number(fields[4]).clamp(0.0, 100.0), memory_used_mb: parse_number(fields[5]).max(0.0), memory_total_mb: parse_number(fields[6]).max(0.0), temperature_celsius: parse_number(fields[7]), power_watts: parse_number(fields[8]).max(0.0) })
}

#[derive(Default)]
struct PsInfo {
    uid: u32,
    parent_pid: u32,
    process_group_id: u32,
    username: String,
    cpu: f64,
    memory_percent: f64,
    rss_kb: u64,
    elapsed: String,
    command: String,
}

fn parse_ps(lines: Option<&Vec<String>>) -> HashMap<u32, PsInfo> {
    let mut result = HashMap::new();
    for line in lines.into_iter().flatten() {
        let mut parts = line.split_whitespace();
        let Some(username) = parts.next() else { continue }; let Some(uid_text) = parts.next() else { continue };
        let Some(pid_text) = parts.next() else { continue }; let Some(parent_pid_text) = parts.next() else { continue };
        let Some(process_group_text) = parts.next() else { continue }; let Some(cpu_text) = parts.next() else { continue };
        let Some(memory_text) = parts.next() else { continue }; let Some(rss_text) = parts.next() else { continue };
        let Some(elapsed) = parts.next() else { continue };
        let Ok(pid) = pid_text.parse::<u32>() else { continue };
        result.insert(pid, PsInfo { uid: uid_text.parse().unwrap_or(0), parent_pid: parent_pid_text.parse().unwrap_or(0), process_group_id: process_group_text.parse().unwrap_or(0), username: username.into(), cpu: parse_number(cpu_text), memory_percent: parse_number(memory_text), rss_kb: rss_text.parse().unwrap_or(0), elapsed: elapsed.into(), command: parts.collect::<Vec<_>>().join(" ") });
    }
    result
}

fn parse_pmon(lines: Option<&Vec<String>>) -> HashMap<(u32, u32), Option<f64>> {
    let mut result = HashMap::new();
    for line in lines.into_iter().flatten().filter(|line| !line.starts_with('#')) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 5 || fields[1] == "-" { continue; }
        let (Ok(gpu_index), Ok(pid)) = (fields[0].parse::<u32>(), fields[1].parse::<u32>()) else { continue };
        let sm_utilization = fields[3].parse::<f64>().ok().map(|value| value.clamp(0.0, 100.0));
        result.insert((gpu_index, pid), sm_utilization);
    }
    result
}

fn parse_gpu_processes(lines: Option<&Vec<String>>, gpus: &[GpuMetric], ps: &HashMap<u32, PsInfo>, pmon: &HashMap<(u32, u32), Option<f64>>, current_user: &str) -> Vec<ProcessMetric> {
    lines.into_iter().flatten().filter_map(|line| {
        let fields: Vec<&str> = line.split(',').map(str::trim).collect();
        if fields.len() < 4 { return None; }
        let pid = fields[1].parse().ok()?;
        let info = ps.get(&pid);
        let username = info.map(|value| value.username.clone()).unwrap_or_else(|| "unknown".into());
        let gpu_index = gpus.iter().find(|gpu| gpu.uuid == fields[0]).map(|gpu| gpu.index).unwrap_or(0);
        Some(ProcessMetric { gpu_uuid: fields[0].into(), gpu_index, pid, parent_pid: info.map(|value| value.parent_pid).unwrap_or(0), username: username.clone(), command: info.filter(|value| !value.command.is_empty()).map(|value| value.command.clone()).unwrap_or_else(|| fields[2].into()), memory_used_mb: parse_number(fields[3]), sm_utilization: pmon.get(&(gpu_index, pid)).copied().flatten(), cpu_percent: info.map(|value| value.cpu).unwrap_or(0.0), elapsed: info.map(|value| value.elapsed.clone()).unwrap_or_else(|| "—".into()), is_current_user: username == current_user, is_group_leader: info.is_some_and(|value| value.process_group_id == pid) })
    }).collect()
}

fn is_system_cpu_process(info: &PsInfo) -> bool {
    let command = info.command.to_ascii_lowercase();
    let executable = command.split_whitespace().next().unwrap_or_default().rsplit('/').next().unwrap_or_default();
    const EXCLUDED_EXECUTABLES: &[&str] = &[
        "systemd", "wireplumber", "pipewire", "pipewire-pulse", "dbus-daemon", "gnome-shell", "xorg", "xwayland", "pulseaudio",
        "nvitop", "nvtop", "htop", "btop", "glances", "node_exporter",
        "tailscale", "tailscaled", "zerotier-one", "openvpn", "openconnect", "wg-quick", "wireguard", "clash", "mihomo", "sing-box", "v2ray", "xray", "cloudflared", "charon", "strongswan", "globalprotect", "forticlient", "vpnagentd",
    ];
    const EXCLUDED_COMMAND_PATTERNS: &[&str] = &[
        "nvitop", ".vscode-server", "code-server", ".cursor-server", "cursor-server", "codex", "claude", "pycharm_helpers", "remote-dev-server", "jetbrains",
    ];
    EXCLUDED_EXECUTABLES.contains(&executable) || EXCLUDED_COMMAND_PATTERNS.iter().any(|pattern| command.contains(pattern))
}

fn parse_cpu_processes(ps: &HashMap<u32, PsInfo>, gpu_processes: &[ProcessMetric], current_user: &str, uid_min: u32) -> Vec<CpuProcessMetric> {
    let gpu_pids: HashSet<u32> = gpu_processes.iter().map(|process| process.pid).collect();
    let child_pids: HashSet<u32> = ps.iter().filter(|(_, info)| gpu_pids.contains(&info.parent_pid)).map(|(pid, _)| *pid).collect();
    let mut entries: Vec<_> = ps.iter().filter(|(pid, info)| {
        let is_gpu_child = child_pids.contains(*pid);
        let is_active_main = **pid == info.process_group_id && info.cpu > 0.0;
        !gpu_pids.contains(*pid) && info.uid >= uid_min && info.rss_kb > 1024 * 1024 && !is_system_cpu_process(info) && (is_gpu_child || is_active_main)
    }).collect();
    entries.sort_by(|(left_pid, left), (right_pid, right)| right.cpu.total_cmp(&left.cpu).then_with(|| left_pid.cmp(right_pid)));

    let mut main_count = 0;
    entries.into_iter().filter(|(pid, _)| {
        if child_pids.contains(*pid) { true } else if main_count < 12 { main_count += 1; true } else { false }
    }).map(|(pid, info)| CpuProcessMetric {
        pid: *pid,
        parent_pid: info.parent_pid,
        username: info.username.clone(),
        command: info.command.clone(),
        cpu_percent: info.cpu,
        memory_percent: info.memory_percent,
        memory_used_bytes: info.rss_kb.saturating_mul(1024),
        elapsed: info.elapsed.clone(),
        is_current_user: info.username == current_user,
        is_group_leader: info.process_group_id == *pid,
    }).collect()
}

fn termination_script(pid: u32) -> Result<String, String> {
    if pid <= 1 { return Err("不能结束 PID 0 或 PID 1".into()); }
    Ok(format!(r#"pid={pid}
current_uid="$(id -u)"
process_uid="$(ps -o uid= -p "$pid" 2>/dev/null | tr -d ' ')"
process_start="$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//;s/ *$//')"
if [ -z "$process_uid" ] || [ -z "$process_start" ]; then printf '__TERMIO_TERMINATE_NOT_FOUND__\n'; exit 44; fi
if [ "$process_uid" != "$current_uid" ]; then printf '__TERMIO_TERMINATE_OWNER_MISMATCH__\n'; exit 45; fi
tree_pids="$pid"
frontier="$pid"
while [ -n "$frontier" ]; do
  next_frontier=""
  for parent_pid in $frontier; do
    children="$(pgrep -P "$parent_pid" 2>/dev/null || true)"
    if [ -n "$children" ]; then next_frontier="$next_frontier $children"; fi
  done
  frontier="$next_frontier"
  if [ -n "$frontier" ]; then tree_pids="$tree_pids $frontier"; fi
done
target_records=""
for target_pid in $tree_pids; do
  target_uid="$(ps -o uid= -p "$target_pid" 2>/dev/null | tr -d ' ')"
  target_start="$(ps -o lstart= -p "$target_pid" 2>/dev/null | sed 's/^ *//;s/ *$//')"
  if [ "$target_uid" = "$current_uid" ] && [ -n "$target_start" ]; then target_records="$target_records$target_pid|$target_uid|$target_start
"; fi
done
printf '%s' "$target_records" | while IFS='|' read -r target_pid target_uid target_start; do
  if [ -n "$target_pid" ]; then kill -TERM "$target_pid" 2>/dev/null || true; fi
done
sleep 3
printf '%s' "$target_records" | while IFS='|' read -r target_pid target_uid target_start; do
  [ -n "$target_pid" ] || continue
  remaining_uid="$(ps -o uid= -p "$target_pid" 2>/dev/null | tr -d ' ')"
  remaining_start="$(ps -o lstart= -p "$target_pid" 2>/dev/null | sed 's/^ *//;s/ *$//')"
  if [ "$remaining_uid" = "$target_uid" ] && [ "$remaining_start" = "$target_start" ]; then kill -KILL "$target_pid" 2>/dev/null || true; fi
done
sleep 1
if ! printf '%s' "$target_records" | while IFS='|' read -r target_pid target_uid target_start; do
  [ -n "$target_pid" ] || continue
  remaining_uid="$(ps -o uid= -p "$target_pid" 2>/dev/null | tr -d ' ')"
  remaining_start="$(ps -o lstart= -p "$target_pid" 2>/dev/null | sed 's/^ *//;s/ *$//')"
  if [ "$remaining_uid" = "$target_uid" ] && [ "$remaining_start" = "$target_start" ]; then exit 46; fi
done; then
  printf '__TERMIO_TERMINATE_REMAINING__\n'
  exit 46
fi
printf '__TERMIO_TERMINATE_OK__\n'"#))
}

pub async fn terminate_process_tree(server: &Server, password: Option<&str>, pid: u32) -> Result<String, String> {
    let script = termination_script(pid)?;
    let (mut command, target) = configured_ssh_command(server, password)?;
    command.arg(target).arg(script).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let output = timeout(Duration::from_secs(12), command.output()).await.map_err(|_| format!("结束 PID {pid} 超时（12 秒）"))?.map_err(|error| format!("无法启动系统 ssh：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if output.status.success() && stdout.contains("__TERMIO_TERMINATE_OK__") {
        return Ok(format!("已结束 PID {pid} 的进程树"));
    }
    if stdout.contains("__TERMIO_TERMINATE_NOT_FOUND__") { return Err(format!("PID {pid} 已不存在，请刷新后重试")); }
    if stdout.contains("__TERMIO_TERMINATE_OWNER_MISMATCH__") { return Err(format!("PID {pid} 不属于当前 SSH 用户，操作已阻止")); }
    if stdout.contains("__TERMIO_TERMINATE_REMAINING__") { return Err(format!("PID {pid} 的部分进程仍在运行，请在终端中检查进程状态")); }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() { format!("无法结束 PID {pid}") } else { classify_ssh_error(&stderr) })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "__TERMIO_USER__\ntongzh\n__TERMIO_UIDMIN__\n1000\n__TERMIO_HOST__\ngpu-box\n__TERMIO_OS__\nubuntu|Ubuntu 22.04 LTS\n__TERMIO_CPUMODEL__\nAMD EPYC 9654 96-Core Processor\n__TERMIO_CPU1__\ncpu 100 0 20 880 0 0 0\n__TERMIO_CPU2__\ncpu 120 0 30 950 0 0 0\n__TERMIO_NETTIME1__\n100.00\n__TERMIO_NETTIME2__\n100.25\n__TERMIO_NET1__\n1000000|500000\n__TERMIO_NET2__\n1524288|762144\n__TERMIO_NETUSER_SUPPORTED__\n1\n__TERMIO_NETSOCK1__\n0 0 10.0.0.2:22 10.0.0.10:50000 uid:1000 ino:11 bytes_sent:1000 bytes_received:2000\n0 0 10.0.0.2:9000 10.0.0.11:41000 uid:1001 ino:22 bytes_sent:500 bytes_received:700\n__TERMIO_NETSOCK2__\n0 0 10.0.0.2:22 10.0.0.10:50000 uid:1000 ino:11 bytes_sent:263144 bytes_received:526288\n0 0 10.0.0.2:9000 10.0.0.11:41000 uid:1001 ino:22 bytes_sent:66036 bytes_received:131772\n__TERMIO_UIDMAP__\n1000|tongzh\n1001|alice\n__TERMIO_LOAD__\n0.06 0.11 0.09 1/100 1\n__TERMIO_MEM__\nMemTotal: 100000 kB\nMemAvailable: 75000 kB\nSwapTotal: 1000 kB\nSwapFree: 900 kB\n__TERMIO_USERCPU__\n5.50\n__TERMIO_NVIDIA__\navailable\n__TERMIO_GPU__\n0, NVIDIA GeForce RTX 4090 D, GPU-abc, 25, 10, 2048, 24564, 48, 110.5\n__TERMIO_GPUPROC__\nGPU-abc, 4242, python, 2048\n__TERMIO_GPUPMON__\n# gpu pid type sm mem\n0 4242 C 73 41 - - - - 2048 0 python\n__TERMIO_PS__\ntongzh 1000 4242 1 4242 12.5 2.0 204800 01:20 python train.py\ntongzh 1000 4343 4242 4242 1.5 1.5 2097152 00:10 python data-loader.py\ntongzh 1000 5000 1 5000 0.8 1.2 1572864 00:30 python cpu-task.py\ntongzh 1000 5500 1 5500 0.9 0.5 1048576 00:20 python small-task.py\ntongzh 1000 5800 1 5800 1.2 1.4 1468006 00:20 /usr/bin/python3 /usr/bin/nvitop\ntongzh 1000 5900 1 5900 1.1 1.5 1572864 00:20 /home/tongzh/.vscode-server/bin/node server-main.js\ntongzh 1000 6000 1 6000 0.7 1.1 1153434 10:00 /usr/lib/systemd/systemd --user\nroot 0 99 1 99 0.2 1.2 1258291 10:00 systemd-worker\n__TERMIO_END__\n";

    #[test]
    fn parses_realistic_snapshot() {
        let snapshot = parse_snapshot("server-1", SAMPLE).unwrap();
        assert_eq!(snapshot.hostname, "gpu-box");
        assert_eq!(snapshot.os_id, "ubuntu");
        assert_eq!(snapshot.system.cpu_model, "AMD EPYC 9654 96-Core Processor");
        assert_eq!(snapshot.gpus.len(), 1);
        assert_eq!(snapshot.processes.len(), 1);
        assert!(snapshot.processes_sampled);
        assert!(snapshot.processes[0].is_current_user);
        assert!(snapshot.processes[0].is_group_leader);
        assert_eq!(snapshot.processes[0].sm_utilization, Some(73.0));
        assert_eq!(snapshot.processes[0].parent_pid, 1);
        assert_eq!(snapshot.cpu_processes.len(), 2);
        assert!(snapshot.disks.is_empty());
        let disk = parse_disk("/mnt/data|250000|1000000|750000|50000").unwrap();
        assert_eq!(disk.used_bytes, 250_000 * 1024);
        assert_eq!(disk.total_bytes, 1_000_000 * 1024);
        assert_eq!(disk.current_user_used_bytes, 50_000 * 1024);
        assert!(parse_disk("/sys/firmware/efi/efivars|1|10|9|0").is_err());
        assert!(parse_disk("/boot/efi|1|10|9|0").is_err());
        assert!(parse_disk("/home|4|10|6|1").is_ok());
        assert_eq!(snapshot.cpu_processes[0].pid, 4343);
        assert_eq!(snapshot.cpu_processes[0].parent_pid, 4242);
        assert!(!snapshot.cpu_processes[0].is_group_leader);
        assert!(snapshot.cpu_processes.iter().any(|process| process.pid == 5000));
        assert!(!snapshot.cpu_processes.iter().any(|process| process.pid == 6000));
        assert!(!snapshot.cpu_processes.iter().any(|process| process.pid == 99));
        assert!(!snapshot.cpu_processes.iter().any(|process| process.pid == 5500));
        assert!(!snapshot.cpu_processes.iter().any(|process| process.pid == 5800));
        assert!(!snapshot.cpu_processes.iter().any(|process| process.pid == 5900));
        assert_eq!(snapshot.system.memory_used_bytes, 25_000 * 1024);
        assert!((snapshot.system.cpu_utilization - 30.0).abs() < 0.01);
        assert!((snapshot.network.download_bytes_per_second - 2.0 * 1024.0 * 1024.0).abs() < 1.0);
        assert!((snapshot.network.upload_bytes_per_second - 1024.0 * 1024.0).abs() < 1.0);
        assert!(snapshot.network.user_breakdown_supported);
        assert!(snapshot.network.users_sampled);
        assert_eq!(snapshot.network.users.len(), 2);
        let own_network = snapshot.network.users.iter().find(|user| user.username == "tongzh").unwrap();
        assert!((own_network.download_bytes_per_second - 2.0 * 1024.0 * 1024.0).abs() < 1.0);
        assert!((own_network.upload_bytes_per_second - 1024.0 * 1024.0).abs() < 1.0);
    }

    #[test]
    fn network_uid_without_ss_metadata_is_resolved_via_proc_socket_owner() {
        let sample = SAMPLE
            .replace("uid:1001 ino:22", "ino:22")
            .replace("__TERMIO_UIDMAP__", "__TERMIO_NETSOCKOWNERS__\n22|1001\n__TERMIO_UIDMAP__");
        let snapshot = parse_snapshot("server-1", &sample).unwrap();
        assert_eq!(snapshot.network.users.len(), 2);
        assert!(snapshot.network.users.iter().any(|user| user.username == "alice" && user.uid == 1001));
        assert!(!snapshot.network.users.iter().any(|user| user.username == "root"));
    }

    #[test]
    fn network_missing_uid_must_not_be_misattributed_to_root() {
        let sample = SAMPLE.replace("uid:1001 ino:22", "ino:22");
        let snapshot = parse_snapshot("server-1", &sample).unwrap();
        assert_eq!(snapshot.network.users.len(), 1);
        assert_eq!(snapshot.network.users[0].username, "tongzh");
    }

    #[test]
    fn network_explicit_root_uid_remains_root() {
        let sample = SAMPLE
            .replace("uid:1001 ino:22", "uid:0 ino:22")
            .replace("__TERMIO_UIDMAP__", "__TERMIO_UIDMAP__\n0|root");
        let snapshot = parse_snapshot("server-1", &sample).unwrap();
        assert!(snapshot.network.users.iter().any(|user| user.username == "root"));
    }

    #[test]
    fn keeps_healthy_gpus_when_one_device_handle_fails() {
        let output = SAMPLE.replacen(
            "available\n__TERMIO_GPU__\n0, NVIDIA GeForce RTX 4090 D, GPU-abc, 25, 10, 2048, 24564, 48, 110.5",
            "degraded\nGPU 0: NVIDIA GeForce RTX 4090 (UUID: GPU-abc)\nUnable to determine the device handle for gpu 0000:D1:00.0: Unknown Error\n__TERMIO_GPU__\n0, NVIDIA GeForce RTX 4090 D, GPU-abc, 25, 10, 2048, 24564, 48, 110.5\n1, Unavailable GPU (0000:D1:00.0), unavailable-0000_D1_00_0, 0, 0, 0, 0, 0, 0",
            1,
        );
        let snapshot = parse_snapshot("server-1", &output).unwrap();
        assert_eq!(snapshot.nvidia_smi, "degraded");
        assert_eq!(snapshot.status, "warning");
        assert_eq!(snapshot.gpus.len(), 2);
        assert_eq!(snapshot.gpus[0].uuid, "GPU-abc");
        assert_eq!(snapshot.gpus[1].uuid, "unavailable-0000_D1_00_0");
        assert_eq!(snapshot.gpus[1].index, 1);
        assert!(snapshot.nvidia_message.as_deref().unwrap_or_default().contains("0000:D1:00.0"));
        assert!(REMOTE_SCRIPT.contains("nvidia_state=degraded"));
        assert!(REMOTE_SCRIPT.contains("/proc/net/dev"));
        assert!(REMOTE_SCRIPT.contains("ss -tineH -O state established"));
    }

    #[test]
    fn clamps_out_of_range_gpu_telemetry() {
        let gpu = parse_gpu("0, NVIDIA Test, GPU-test, 104.2, -3, -1, 40960, 35, -4").unwrap();
        assert_eq!(gpu.utilization, 100.0);
        assert_eq!(gpu.memory_utilization, 0.0);
        assert_eq!(gpu.memory_used_mb, 0.0);
        assert_eq!(gpu.power_watts, 0.0);
    }

    #[test]
    fn classifies_changed_host_key() {
        assert!(classify_ssh_error("Host key verification failed").contains("中间人攻击"));
    }

    #[test]
    fn classifies_a_local_network_component_closing_the_connection() {
        assert!(classify_ssh_error("Connection closed by 127.0.0.1 port 7897").contains("本机网络组件"));
    }

    #[test]
    fn excludes_development_and_monitoring_services_from_cpu_tasks() {
        for command in [
            "/usr/bin/python3 /usr/bin/nvitop",
            "/home/test/.vscode-server/bin/node server-main.js",
            "/home/test/.codex/bin/codex app-server",
            "/home/test/.local/bin/claude",
            "/usr/bin/mihomo -d /etc/mihomo",
            "/usr/sbin/openvpn --config client.conf",
        ] {
            assert!(is_system_cpu_process(&PsInfo { command: command.into(), ..Default::default() }));
        }
        assert!(!is_system_cpu_process(&PsInfo { command: "python train.py".into(), ..Default::default() }));
    }

    #[test]
    fn preserves_process_sampling_signal_when_process_query_is_skipped() {
        let process_start = SAMPLE.find("__TERMIO_GPUPROC__").unwrap();
        let end = SAMPLE.find("__TERMIO_END__").unwrap();
        let output = format!("{}{}", &SAMPLE[..process_start], &SAMPLE[end..]);
        let snapshot = parse_snapshot("server-1", &output).unwrap();
        assert!(!snapshot.processes_sampled);
        assert!(snapshot.processes.is_empty());
        assert!(snapshot.cpu_processes.is_empty());
    }

    #[test]
    fn termination_only_accepts_safe_process_ids() {
        assert!(termination_script(1).is_err());
        let script = termination_script(4242).unwrap();
        assert!(script.contains("process_uid"));
        assert!(script.contains("process_start"));
        assert!(script.contains("frontier=\"$pid\""));
        assert!(script.contains("pgrep -P \"$parent_pid\""));
        assert!(script.contains("target_records"));
        assert!(script.contains("kill -TERM \"$target_pid\""));
        assert!(script.contains("remaining_start"));
        assert!(script.contains("__TERMIO_TERMINATE_REMAINING__"));
        assert!(!script.contains("kill -TERM -- \"-$process_pgid\""));
    }

    #[test]
    fn user_cpu_awk_does_not_use_ambiguous_redirection_expression() {
        assert!(REMOTE_SCRIPT.contains("if (n > 0) printf \"%.2f\\n\", s/n; else printf \"%.2f\\n\", s+0"));
        assert!(!REMOTE_SCRIPT.contains("n>0?s/n:s+0"));
    }

    #[test]
    fn collector_prefers_standard_gpu_process_memory_field_with_legacy_fallback() {
        assert!(REMOTE_SCRIPT.contains("used_gpu_memory"));
        assert!(REMOTE_SCRIPT.contains("used_memory"));
        assert!(REMOTE_SCRIPT.contains("query_gpu_processes \"-i $gpu_index\""));
    }

    #[test]
    fn recognizes_ascend_snapshots_without_changing_gpu_compatibility_fields() {
        let sample = SAMPLE.replace("__TERMIO_NVIDIA__", "__TERMIO_ACCELERATOR__\nascend\n__TERMIO_NVIDIA__")
            .replace("NVIDIA GeForce RTX 4090 D, GPU-abc", "Ascend 910B, NPU-0-0");
        let snapshot = parse_snapshot("server-npu", &sample).unwrap();
        assert_eq!(snapshot.accelerator_vendor, "ascend");
        assert_eq!(snapshot.gpus[0].uuid, "NPU-0-0");
        assert!(REMOTE_SCRIPT.contains("npu-smi info"));
        assert!(REMOTE_SCRIPT.contains("Ascend"));
    }

    fn auth_server(auth_method: &str) -> Server {
        Server {
            id: "id".into(), name: "GPU".into(), host: "gpu-alias".into(), port: 22, username: "user".into(),
            sampling_interval_seconds: 2, history_retention_days: 90, sort_order: 0, auth_method: auth_method.into(),
            status: "unknown".into(), last_error: None, last_seen_at: None,
        }
    }

    #[test]
    fn ssh_config_auth_keeps_the_users_openssh_config_enabled() {
        let command = collection_display_command(&auth_server("sshConfig"), true, true);
        assert!(!command.contains("-F '/dev/null'"));
        assert!(!command.contains("-F 'NUL'"));
        assert!(command.contains("gpu-alias"));
        assert!(!command.contains("user@gpu-alias"));
    }

    #[test]
    fn password_auth_explicitly_ignores_ssh_config() {
        let command = collection_display_command(&auth_server("password"), true, true);
        assert!(command.contains("-F "));
        assert!(command.contains("PubkeyAuthentication=no"));
    }

}
