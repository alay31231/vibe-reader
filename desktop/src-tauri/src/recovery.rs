use crate::logging::Logs;
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, process::Command};

#[derive(Serialize, Deserialize)]
pub struct RuntimeState {
    pub instance_id: String,
    pub backend_pid: u32,
    pub backend_port: Option<u16>,
    pub start_time: u64,
    #[serde(alias = "backend_executable")]
    pub backend_command_prefix: String,
    pub backend_marker: String,
}

pub fn state_path(directory_name: &str) -> PathBuf {
    let home = std::env::var_os("HOME").unwrap_or_default();
    PathBuf::from(home)
        .join("Library/Application Support")
        .join(directory_name)
        .join("runtime.json")
}

pub fn write(directory_name: &str, state: &RuntimeState) -> std::io::Result<()> {
    let path = state_path(directory_name);
    fs::create_dir_all(path.parent().unwrap())?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, serde_json::to_vec(state)?)?;
    fs::rename(tmp, path)
}

pub fn clear(directory_name: &str) {
    let _ = fs::remove_file(state_path(directory_name));
}

pub fn recover(logs: &Logs, directory_name: &str) {
    let path = state_path(directory_name);
    let Ok(raw) = fs::read(&path) else {
        return;
    };
    let Ok(state) = serde_json::from_slice::<RuntimeState>(&raw) else {
        logs.lifecycle("invalid runtime state; leaving it in place");
        return;
    };
    let pid = state.backend_pid.to_string();
    let info = Command::new("/bin/ps")
        .args(["-p", &pid, "-o", "ppid=", "-o", "command="])
        .output();
    if let Ok(info) = info {
        let line = String::from_utf8_lossy(&info.stdout);
        let mut parts = line.trim().splitn(2, char::is_whitespace);
        let parent = parts.next().and_then(|v| v.parse::<u32>().ok());
        let cmd = parts.next().unwrap_or("");
        if parent == Some(1)
            && cmd.starts_with(&state.backend_command_prefix)
            && (state.backend_marker.is_empty() || cmd.contains(&state.backend_marker))
            && cmd.contains(&format!("--instance-id {}", state.instance_id))
        {
            logs.lifecycle(&format!("terminating verified orphan backend pid={pid}"));
            unsafe {
                libc::kill(-(state.backend_pid as i32), libc::SIGTERM);
            }
        } else if !line.trim().is_empty() {
            logs.lifecycle(&format!(
                "stale state pid={pid} did not match orphan identity; untouched"
            ));
            return;
        }
    }
    clear(directory_name);
}
