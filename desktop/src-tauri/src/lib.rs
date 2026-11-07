mod backend;
mod config;
mod lifecycle;
mod logging;
mod recovery;

use backend::BackendManager;
use config::Config;
use lifecycle::Lifecycle;
use logging::Logs;
use std::{
    path::PathBuf,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{
    webview::NewWindowResponse, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

struct DesktopState {
    manager: Arc<BackendManager>,
    lifecycle: Arc<Lifecycle>,
    logs: Arc<Logs>,
    restart_pending: Arc<AtomicBool>,
}

#[tauri::command]
fn restart_backend(app: tauri::AppHandle, state: tauri::State<'_, DesktopState>) {
    if state.lifecycle.completed() {
        return;
    }
    if state.restart_pending.swap(true, Ordering::SeqCst) {
        return;
    }
    let manager = state.manager.clone();
    let pending = state.restart_pending.clone();
    std::thread::spawn(move || {
        manager.stop();
        let _ = manager.start(app).join();
        pending.store(false, Ordering::SeqCst);
    });
}

#[tauri::command]
fn open_logs(state: tauri::State<'_, DesktopState>) -> Result<(), String> {
    Command::new("/usr/bin/open")
        .arg(&state.logs.directory)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle, state: tauri::State<'_, DesktopState>) {
    state.lifecycle.request_exit(app);
}

fn project_root(app: &tauri::App) -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os("LOCALAPP_PROJECT_ROOT") {
        return Ok(PathBuf::from(value));
    }
    let resource = app
        .path()
        .resolve(
            "resources/project-root.txt",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| e.to_string())?;
    let path =
        std::fs::read_to_string(&resource).map_err(|e| format!("{}: {e}", resource.display()))?;
    Ok(PathBuf::from(path.trim()))
}

pub fn run() {
    let config = Arc::new(Config::load().expect("invalid Local Web App configuration"));
    let logs = Arc::new(Logs::new(&config.log_directory).expect("cannot open application logs"));
    logs.lifecycle(&format!(
        "app start version={} pid={}",
        env!("CARGO_PKG_VERSION"),
        std::process::id()
    ));
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            restart_backend,
            open_logs,
            quit_app
        ])
        .setup({
            let logs = logs.clone();
            let config = config.clone();
            move |app| {
                let open_logs_item =
                    MenuItem::with_id(app, "open_logs", "打开日志文件夹", true, None::<&str>)?;
                let quit_item = MenuItem::with_id(
                    app,
                    "quit_desktop",
                    format!("退出 {}", config.display_name),
                    true,
                    Some("Cmd+Q"),
                )?;
                let app_menu = Submenu::with_items(
                    app,
                    &config.display_name,
                    true,
                    &[
                        &PredefinedMenuItem::about(app, None, None)?,
                        &PredefinedMenuItem::separator(app)?,
                        &open_logs_item,
                        &PredefinedMenuItem::separator(app)?,
                        &quit_item,
                    ],
                )?;
                let edit_menu = Submenu::with_items(
                    app,
                    "编辑",
                    true,
                    &[
                        &PredefinedMenuItem::undo(app, None)?,
                        &PredefinedMenuItem::redo(app, None)?,
                        &PredefinedMenuItem::separator(app)?,
                        &PredefinedMenuItem::cut(app, None)?,
                        &PredefinedMenuItem::copy(app, None)?,
                        &PredefinedMenuItem::paste(app, None)?,
                        &PredefinedMenuItem::select_all(app, None)?,
                    ],
                )?;
                let reload_item =
                    MenuItem::with_id(app, "reload_page", "刷新页面", true, Some("Cmd+R"))?;
                let view_menu = Submenu::with_items(app, "显示", true, &[&reload_item])?;
                let window_menu = Submenu::with_items(
                    app,
                    "窗口",
                    true,
                    &[
                        &PredefinedMenuItem::minimize(app, None)?,
                        &PredefinedMenuItem::close_window(app, None)?,
                    ],
                )?;
                let menu =
                    Menu::with_items(app, &[&app_menu, &edit_menu, &view_menu, &window_menu])?;
                app.set_menu(menu)?;
                let log_directory = logs.directory.clone();
                app.on_menu_event(move |handle, event| {
                    if event.id() == "open_logs" {
                        let _ = Command::new("/usr/bin/open").arg(&log_directory).spawn();
                    }
                    if event.id() == "quit_desktop" {
                        handle
                            .state::<DesktopState>()
                            .lifecycle
                            .request_exit(handle.clone());
                    }
                    if event.id() == "reload_page" {
                        if let Some(window) = handle.get_webview_window("main") {
                            let _ = window.eval("window.location.reload()");
                        }
                    }
                });
                recovery::recover(&logs, &config.runtime_directory);
                let project = project_root(app).unwrap_or_else(|error| {
                    logs.lifecycle(&format!("project root missing: {error}"));
                    PathBuf::new()
                });
                logs.lifecycle(&format!("project root={}", project.display()));
                let manager = Arc::new(BackendManager::new(project, config.clone(), logs.clone()));
                let lifecycle = Arc::new(Lifecycle::new(manager.clone(), logs.clone()));
                app.manage(DesktopState {
                    manager: manager.clone(),
                    lifecycle,
                    logs: logs.clone(),
                    restart_pending: Arc::new(AtomicBool::new(false)),
                });
                let nav_manager = manager.clone();
                let load_manager = manager.clone();
                let new_window_manager = manager.clone();
                let repaint_flip = Arc::new(AtomicBool::new(false));
                let repaint_logs = logs.clone();
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title(&config.window_title)
                    .inner_size(1180.0, 800.0)
                    .min_inner_size(700.0, 550.0)
                    .on_navigation(move |url| {
                        if url.scheme() == "tauri" || nav_manager.allows_url(url) {
                            return true;
                        }
                        if matches!(url.scheme(), "http" | "https")
                            && url.host_str() != Some("127.0.0.1")
                        {
                            let _ = Command::new("/usr/bin/open").arg(url.as_str()).spawn();
                        }
                        false
                    })
                    .on_page_load(move |window, payload| {
                        if payload.event() == tauri::webview::PageLoadEvent::Finished
                            && load_manager.allows_url(payload.url())
                        {
                            // WKWebView sometimes loads the DOM without painting when
                            // the startup page navigates to Gradio in a background app.
                            // A one-pixel native resize invalidates its drawing surface.
                            if let Ok(size) = window.inner_size() {
                                let delta = if repaint_flip.fetch_xor(true, Ordering::SeqCst) {
                                    -1_i32
                                } else {
                                    1_i32
                                };
                                let width = (size.width as i32 + delta).max(701) as u32;
                                let _ =
                                    window.set_size(tauri::PhysicalSize::new(width, size.height));
                                repaint_logs
                                    .lifecycle("backend webview loaded; refreshed drawing surface");
                            }
                        }
                    })
                    .on_new_window(move |url, _| {
                        if new_window_manager.allows_url(&url)
                            || (matches!(url.scheme(), "http" | "https")
                                && url.host_str() != Some("127.0.0.1"))
                        {
                            let _ = Command::new("/usr/bin/open").arg(url.as_str()).spawn();
                        }
                        NewWindowResponse::Deny
                    })
                    .build()?;
                let _ = manager.start(app.handle().clone());
                Ok(())
            }
        });
    let app = builder
        .build(tauri::generate_context!())
        .expect("Tauri initialization failed");
    app.run(|app, event| {
        let state = app.state::<DesktopState>();
        match event {
            RunEvent::WindowEvent {
                event: WindowEvent::CloseRequested { api, .. },
                ..
            } => {
                if !state.lifecycle.completed() {
                    api.prevent_close();
                    state.lifecycle.request_exit(app.clone());
                }
            }
            RunEvent::ExitRequested { api, .. } => {
                if !state.lifecycle.completed() {
                    api.prevent_exit();
                    state.lifecycle.request_exit(app.clone());
                }
            }
            _ => {}
        }
    });
}
