use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

pub struct Logs {
    pub directory: PathBuf,
    rust: Mutex<File>,
    backend: Mutex<File>,
}

impl Logs {
    pub fn new(directory_name: &str) -> std::io::Result<Self> {
        let home =
            std::env::var_os("HOME").ok_or_else(|| std::io::Error::other("HOME is missing"))?;
        let directory = PathBuf::from(home)
            .join("Library/Logs")
            .join(directory_name);
        fs::create_dir_all(&directory)?;
        let open = |name: &str| {
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(directory.join(name))
        };
        Ok(Self {
            rust: Mutex::new(open("lifecycle.log")?),
            backend: Mutex::new(open("backend.log")?),
            directory,
        })
    }

    pub fn lifecycle(&self, message: &str) {
        self.write(&self.rust, message);
    }
    pub fn backend(&self, message: &str) {
        self.write(&self.backend, message);
    }
    fn write(&self, file: &Mutex<File>, message: &str) {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|v| v.as_secs())
            .unwrap_or_default();
        if let Ok(mut file) = file.lock() {
            let _ = writeln!(file, "[{stamp}] {message}");
            let _ = file.flush();
        }
    }
}
