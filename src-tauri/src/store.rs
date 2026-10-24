use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 停用模块的存档条目（ADR-004）：停用即从目标文件中整块移除，
/// 正文保存在这里；state.json 中存在而文件中不存在的条目即「已停用」。
#[derive(Serialize, Deserialize)]
struct Entry {
    content: String,
    at: u64,
    /// 停用时的前驱模块名（位置锚）：启用时优先插回其之后。
    #[serde(default)]
    after: Option<String>,
}

/// 对前端暴露的存档条目。
#[derive(Serialize, Clone)]
pub struct ArchivedEntry {
    pub content: String,
    pub after: Option<String>,
}

/// 存档存储：外层键为小写的目标文件路径，内层键为模块名。
/// ADR-004 之后它是停用模块的唯一事实来源，可靠性要求与目标文件一致：
/// 原子写、损坏时保留现场。
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
        let data = match fs::read(&file) {
            Ok(bytes) => match serde_json::from_slice(&bytes) {
                Ok(data) => data,
                Err(e) => {
                    // 损坏时保留现场再以空表继续，避免下次写盘抹掉可恢复内容。
                    let bak = dir.join("state.json.bak");
                    let _ = fs::rename(&file, &bak);
                    eprintln!("[pizzic] state.json 解析失败({e})，已备份为 state.json.bak");
                    HashMap::new()
                }
            },
            Err(_) => HashMap::new(),
        };
        Store { file, data }
    }

    fn persist(&self) -> Result<(), String> {
        let parent = self
            .file
            .parent()
            .ok_or_else(|| "存档路径异常".to_string())?;
        fs::create_dir_all(parent).map_err(|e| format!("创建存档目录失败: {e}"))?;
        let bytes =
            serde_json::to_vec_pretty(&self.data).map_err(|e| format!("序列化存档失败: {e}"))?;
        // 与目标文件写入对齐：临时文件 + 原子替换，崩溃不留半截 JSON。
        let mut persisted = false;
        if let Ok(mut tf) = tempfile::NamedTempFile::new_in(parent) {
            if tf.write_all(&bytes).is_ok() && tf.persist(&self.file).is_ok() {
                persisted = true;
            }
        }
        if !persisted {
            fs::write(&self.file, &bytes).map_err(|e| format!("写入存档失败: {e}"))?;
        }
        Ok(())
    }

    pub fn get(&self, file: &str) -> HashMap<String, ArchivedEntry> {
        self.data
            .get(&file.to_lowercase())
            .map(|mods| {
                mods.iter()
                    .map(|(k, v)| {
                        (
                            k.clone(),
                            ArchivedEntry {
                                content: v.content.clone(),
                                after: v.after.clone(),
                            },
                        )
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn set(
        &mut self,
        file: &str,
        name: &str,
        content: Option<String>,
        after: Option<String>,
    ) -> Result<(), String> {
        let key = file.to_lowercase();
        match content {
            Some(text) => {
                self.data.entry(key).or_default().insert(
                    name.to_string(),
                    Entry {
                        content: text,
                        at: now_millis(),
                        after,
                    },
                );
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
