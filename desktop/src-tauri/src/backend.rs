use crate::{
    config::Config,
    logging::Logs,
    recovery::{self, RuntimeState},
};
use serde::Deserialize;
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    os::unix::process::CommandExt,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Phase {
    Starting,
    Ready,
    Busy,
    Stopping,
    Stopped,
    Failed,
}

struct Process {
    child: Option<Child>,
    port: Option<u16>,
    token: String,
    instance_id: String,
    phase: Phase,
    start_time: u64,
}

pub struct BackendManager {
    process: Mutex<Process>,
    logs: Arc<Logs>,
    project: PathBuf,
    config: Arc<Config>,
}

#[derive(Deserialize)]
struct ReadyMessage {
    port: u16,
    pid: u32,
}

fn observed_command_prefix(pid: u32, marker: &str, instance_id: &str, fallback: &str) -> String {
    if marker.is_empty() {
        return fallback.to_owned();
    }
    let output = Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output();
    if let Ok(output) = output {
        let command = String::from_utf8_lossy(&output.stdout);
        if command.contains(&format!("--instance-id {instance_id}")) {
            if let Some((prefix, _)) = command.split_once(marker) {
                let prefix = prefix.trim_end();
                if !prefix.is_empty() {
                    return prefix.to_owned();
                }
            }
        }
    }
    fallback.to_owned()
}

impl BackendManager {
    pub fn new(project: PathBuf, config: Arc<Config>, logs: Arc<Logs>) -> Self {
        Self {
            process: Mutex::new(Process {
                child: None,
                port: None,
                token: String::new(),
                instance_id: String::new(),
                phase: Phase::Stopped,
                start_time: 0,
            }),
            logs,
            project,
            config,
        }
    }

    pub fn phase(&self) -> Phase {
        self.process.lock().unwrap().phase
    }
    pub fn allows_url(&self, url: &tauri::Url) -> bool {
        url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port() == self.process.lock().unwrap().port
    }
    fn status(app: &AppHandle, message: &str, failed: bool) {
        if let Some(window) = app.get_webview_window("main") {
            let arg = serde_json::to_string(message).unwrap_or_else(|_| "\"Error\"".into());
            let _ = window.eval(&format!("window.setStartupStatus?.({arg}, {failed})"));
        }
    }

    pub fn start(self: &Arc<Self>, app: AppHandle) -> thread::JoinHandle<()> {
        let this = Arc::clone(self);
        thread::spawn(move || this.start_inner(app))
    }

    fn start_inner(self: Arc<Self>, app: AppHandle) {
        let executable = self.config.executable(&self.project);
        let workdir = self.config.workdir(&self.project);
        let args: Vec<String> = self
            .config
            .backend
            .args
            .iter()
            .map(|arg| Config::expand(arg, &self.project))
            .collect();
        let marker = args.first().cloned().unwrap_or_default();
        if !executable.is_file() || !workdir.is_dir() {
            self.fail(
                &app,
                "找不到 Backend 可执行文件或工作目录。请打开日志查看项目配置。",
            );
            return;
        }
        let instance_id = uuid::Uuid::new_v4().to_string();
        let token = uuid::Uuid::new_v4().to_string() + &uuid::Uuid::new_v4().to_string();
        let mut command = Command::new(&executable);
        command
            .args(&args)
            .arg("--instance-id")
            .arg(&instance_id)
            .current_dir(&workdir)
            .env("APP_DESKTOP_MANAGED", "1")
            .env("APP_CONTROL_TOKEN", &token)
            .env("APP_PARENT_PID", std::process::id().to_string())
            .env("APP_PROJECT_ROOT", &self.project)
            .env("APP_INSTANCE_ID", &instance_id)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in &self.config.backend.env {
            command.env(key, Config::expand(value, &self.project));
        }
        unsafe {
            command.pre_exec(|| {
                if libc::setpgid(0, 0) == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                self.fail(&app, &format!("Backend 启动失败：{error}"));
                return;
            }
        };
        let pid = child.id();
        let started = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|v| v.as_secs())
            .unwrap_or_default();
        let mut child = child;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        {
            let mut process = self.process.lock().unwrap();
            process.child = Some(child);
            process.port = None;
            process.token = token.clone();
            process.instance_id = instance_id.clone();
            process.phase = Phase::Starting;
            process.start_time = started;
        }
        self.logs
            .lifecycle(&format!("backend spawn pid={pid} instance={instance_id}"));
        let _ = recovery::write(
            &self.config.runtime_directory,
            &RuntimeState {
                instance_id: instance_id.clone(),
                backend_pid: pid,
                backend_port: None,
                start_time: started,
                backend_command_prefix: executable.display().to_string(),
                backend_marker: marker.clone(),
            },
        );
        Self::status(&app, "正在启动 Backend…", false);

        let (tx, rx) = mpsc::channel();
        if let Some(stdout) = stdout {
            let logs = self.logs.clone();
            let loading_app = app.clone();
            thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if let Some(value) = line.strip_prefix("APP_BACKEND_READY ") {
                        if let Ok(ready) = serde_json::from_str::<ReadyMessage>(value) {
                            let _ = tx.send(ready);
                        }
                    } else {
                        if let Some(stage) = line.strip_prefix("APP_BACKEND_STAGE ") {
                            Self::status(&loading_app, stage, false);
                        }
                        logs.backend(&format!("stdout: {line}"));
                    }
                }
            });
        }
        if let Some(stderr) = stderr {
            let logs = self.logs.clone();
            thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    logs.backend(&format!("stderr: {line}"));
                }
            });
        }
        let watcher = self.clone();
        let watch_app = app.clone();
        let watch_id = instance_id.clone();
        thread::spawn(move || watcher.monitor(watch_app, watch_id));

        match rx.recv_timeout(Duration::from_secs(self.config.backend.startup_timeout_sec)) {
            Ok(ready) if ready.pid == pid && ready.port > 0 => {
                self.logs.lifecycle(&format!(
                    "backend ready pid={} port={}",
                    ready.pid, ready.port
                ));
                {
                    let mut process = self.process.lock().unwrap();
                    if process.instance_id != instance_id || process.phase != Phase::Starting {
                        return;
                    }
                    process.port = Some(ready.port);
                }
                let _ = recovery::write(
                    &self.config.runtime_directory,
                    &RuntimeState {
                        instance_id: instance_id.clone(),
                        backend_pid: pid,
                        backend_port: Some(ready.port),
                        start_time: started,
                        backend_command_prefix: observed_command_prefix(
                            pid,
                            &marker,
                            &instance_id,
                            &executable.display().to_string(),
                        ),
                        backend_marker: marker,
                    },
                );
                Self::status(&app, "正在检查 Backend 健康状态…", false);
                let healthy = (0..40).any(|_| {
                    let ok = self.request("GET", "/_desktop/health").is_ok();
                    if !ok {
                        thread::sleep(Duration::from_millis(250));
                    }
                    ok
                });
                if !healthy {
                    self.stop();
                    self.fail(
                        &app,
                        "Backend 已报告就绪，但健康检查失败。请打开日志查看详情。",
                    );
                    return;
                }
                self.logs.lifecycle("health check passed");
                self.process.lock().unwrap().phase = Phase::Ready;
                if let Some(window) = app.get_webview_window("main") {
                    if let Ok(url) = format!("http://127.0.0.1:{}/", ready.port).parse() {
                        let _ = window.navigate(url);
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
            Ok(_) => {
                self.stop();
                self.fail(&app, "Backend 返回无效的 ready 消息。");
            }
            Err(_) => {
                self.stop();
                self.fail(&app, "Backend 启动超时。请打开日志查看错误。");
            }
        }
    }

    fn monitor(self: Arc<Self>, app: AppHandle, id: String) {
        loop {
            thread::sleep(Duration::from_millis(400));
            let outcome = {
                let mut process = self.process.lock().unwrap();
                if process.instance_id != id {
                    return;
                }
                process
                    .child
                    .as_mut()
                    .and_then(|child| child.try_wait().ok().flatten())
            };
            if let Some(exit) = outcome {
                let mut process = self.process.lock().unwrap();
                if process.instance_id != id {
                    return;
                }
                let stopping = process.phase == Phase::Stopping;
                process.child = None;
                process.phase = if stopping {
                    Phase::Stopped
                } else {
                    Phase::Failed
                };
                drop(process);
                recovery::clear(&self.config.runtime_directory);
                self.logs
                    .lifecycle(&format!("backend exit status={exit}; expected={stopping}"));
                if !stopping {
                    self.fail(&app, "Backend 异常退出。可以打开日志并重新启动 Backend。");
                }
                return;
            }
            if matches!(self.phase(), Phase::Ready | Phase::Busy) {
                if let Ok(status) = self.request("GET", "/_desktop/status") {
                    let mut process = self.process.lock().unwrap();
                    if process.instance_id == id {
                        process.phase = if status.contains("\"busy\":true")
                            || status.contains("\"busy\": true")
                        {
                            Phase::Busy
                        } else {
                            Phase::Ready
                        };
                    }
                }
            }
        }
    }

    fn fail(&self, app: &AppHandle, message: &str) {
        self.logs.lifecycle(&format!("startup failure: {message}"));
        self.process.lock().unwrap().phase = Phase::Failed;
        if let Some(window) = app.get_webview_window("main") {
            if let Ok(mut url) = "tauri://localhost/index.html".parse::<tauri::Url>() {
                url.query_pairs_mut().append_pair("error", message);
                let _ = window.navigate(url);
            }
        }
    }

    pub fn request(&self, method: &str, path: &str) -> std::io::Result<String> {
        let (port, token) = {
            let process = self.process.lock().unwrap();
            (
                process
                    .port
                    .ok_or_else(|| std::io::Error::other("port unavailable"))?,
                process.token.clone(),
            )
        };
        let mut stream = TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().unwrap(),
            Duration::from_secs(2),
        )?;
        stream.set_read_timeout(Some(Duration::from_secs(2)))?;
        write!(stream, "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")?;
        let mut response = String::new();
        stream.read_to_string(&mut response)?;
        let status = response.lines().next().unwrap_or("");
        if !status.starts_with("HTTP/1.") || status.split_whitespace().nth(1) != Some("200") {
            return Err(std::io::Error::other(format!(
                "control API failed: {}",
                if status.is_empty() {
                    "empty response"
                } else {
                    status
                }
            )));
        }
        Ok(response)
    }

    pub fn stop(&self) {
        let (pid, phase) = {
            let mut p = self.process.lock().unwrap();
            let pid = p.child.as_ref().map(Child::id);
            let phase = p.phase;
            p.phase = Phase::Stopping;
            (pid, phase)
        };
        let Some(pid) = pid else {
            recovery::clear(&self.config.runtime_directory);
            return;
        };
        self.logs.lifecycle(&format!(
            "close requested backend pid={pid} phase={phase:?}"
        ));
        let available = self.request("GET", "/_desktop/status").is_ok();
        if available {
            self.logs.lifecycle("backend status received");
            if self.request("POST", "/_desktop/prepare-exit").is_ok() {
                self.logs.lifecycle("prepare-exit accepted");
            }
            let until = Instant::now() + Duration::from_secs(15);
            while Instant::now() < until {
                let status = self.request("GET", "/_desktop/status");
                if status.as_deref().is_ok_and(|text| {
                    text.contains("\"busy\":false") || text.contains("\"busy\": false")
                }) {
                    break;
                }
                thread::sleep(Duration::from_millis(250));
            }
            if self.request("POST", "/_desktop/shutdown").is_ok() {
                self.logs.lifecycle("shutdown accepted");
            }
        }
        if !self.wait_child(
            pid,
            if available {
                Duration::from_secs(5)
            } else {
                Duration::from_millis(200)
            },
        ) {
            self.logs
                .lifecycle(&format!("terminate process group pid={pid}"));
            unsafe {
                libc::kill(-(pid as i32), libc::SIGTERM);
            }
            if !self.wait_child(pid, Duration::from_secs(3)) {
                self.logs
                    .lifecycle(&format!("force kill process group pid={pid}"));
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
                self.wait_child(pid, Duration::from_secs(2));
            }
        }
        self.process.lock().unwrap().phase = Phase::Stopped;
        recovery::clear(&self.config.runtime_directory);
    }

    fn wait_child(&self, pid: u32, duration: Duration) -> bool {
        let until = Instant::now() + duration;
        while Instant::now() < until {
            let mut p = self.process.lock().unwrap();
            if p.child.as_ref().map(Child::id) != Some(pid) {
                return true;
            }
            if p.child
                .as_mut()
                .is_some_and(|child| child.try_wait().ok().flatten().is_some())
            {
                p.child = None;
                return true;
            }
            drop(p);
            thread::sleep(Duration::from_millis(100));
        }
        false
    }
}
