use serde::Deserialize;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

#[derive(Clone, Deserialize)]
pub struct BackendConfig {
    pub executable: String,
    pub args: Vec<String>,
    pub workdir: String,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default = "default_timeout")]
    pub startup_timeout_sec: u64,
}

fn default_timeout() -> u64 {
    120
}

#[derive(Clone, Deserialize)]
pub struct Config {
    pub display_name: String,
    pub window_title: String,
    pub log_directory: String,
    pub runtime_directory: String,
    pub backend: BackendConfig,
}

impl Config {
    pub fn load() -> Result<Self, String> {
        let config: Self = serde_json::from_str(include_str!("../localapp.json"))
            .map_err(|error| format!("invalid localapp.json: {error}"))?;
        for value in [&config.log_directory, &config.runtime_directory] {
            if value.is_empty() || value == "." || value == ".." || value.contains('/') {
                return Err("log/runtime directory must be a single directory name".into());
            }
        }
        if config.backend.executable.is_empty() || config.backend.startup_timeout_sec == 0 {
            return Err("backend executable and startup timeout are required".into());
        }
        Ok(config)
    }

    pub fn expand(value: &str, root: &Path) -> String {
        value.replace("{project_root}", &root.to_string_lossy())
    }

    pub fn executable(&self, root: &Path) -> PathBuf {
        let value = PathBuf::from(Self::expand(&self.backend.executable, root));
        if value.is_absolute() {
            value
        } else {
            root.join(value)
        }
    }

    pub fn workdir(&self, root: &Path) -> PathBuf {
        let value = PathBuf::from(Self::expand(&self.backend.workdir, root));
        if value.is_absolute() {
            value
        } else {
            root.join(value)
        }
    }
}
