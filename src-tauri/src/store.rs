use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Deserialize)]
struct Entry {
    content: String,
    at: u64,
}

/// 停用模块的正文存档：文件停用某个模块后，其内容保存在这里，
/// 重新启用时从中恢复。键为小写的目标文件路径，内层键为模块名。
pub struct Store {
    file: PathBuf,
    data: HashMap<String, HashMap<String, Entry>>,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl Store {
    pub fn load(dir: &Path) -> Self {
        let file = dir.join("state.json");
        let data = fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Store { file, data }
    }

    fn persist(&self) -> Result<(), String> {
        if let Some(parent) = self.file.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建存档目录失败: {e}"))?;
        }
        let bytes = serde_json::to_vec_pretty(&self.data).map_err(|e| format!("序列化存档失败: {e}"))?;
        fs::write(&self.file, bytes).map_err(|e| format!("写入存档失败: {e}"))
    }

    pub fn get(&self, file: &str) -> HashMap<String, String> {
        self.data
            .get(&file.to_lowercase())
            .map(|mods| mods.iter().map(|(k, v)| (k.clone(), v.content.clone())).collect())
            .unwrap_or_default()
    }

    pub fn set(&mut self, file: &str, name: &str, content: Option<String>) -> Result<(), String> {
        let key = file.to_lowercase();
        match content {
            Some(text) => {
                self.data
                    .entry(key)
                    .or_default()
                    .insert(name.to_string(), Entry { content: text, at: now_millis() });
            }
            None => {
                if let Some(mods) = self.data.get_mut(&key) {
                    mods.remove(name);
                    if mods.is_empty() {
                        self.data.remove(&key);
                    }
                }
            }
        }
        self.persist()
    }
}
