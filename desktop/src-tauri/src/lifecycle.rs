use crate::{backend::BackendManager, logging::Logs};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
};
use tauri::AppHandle;

pub struct Lifecycle {
    started: AtomicBool,
    completed: AtomicBool,
    manager: Arc<BackendManager>,
    logs: Arc<Logs>,
}

impl Lifecycle {
    pub fn new(manager: Arc<BackendManager>, logs: Arc<Logs>) -> Self {
        Self {
            started: AtomicBool::new(false),
            completed: AtomicBool::new(false),
            manager,
            logs,
        }
    }
    pub fn completed(&self) -> bool {
        self.completed.load(Ordering::SeqCst)
    }
    pub fn request_exit(self: &Arc<Self>, app: AppHandle) {
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        self.logs.lifecycle("app exit requested");
        let this = self.clone();
        thread::spawn(move || {
            this.manager.stop();
            this.logs.lifecycle("app cleanup complete");
            this.completed.store(true, Ordering::SeqCst);
            app.exit(0);
        });
    }
}
