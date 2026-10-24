mod store;
mod targets;
mod watch;

use serde::Serialize;
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::SystemTime;
use tauri::{AppHandle, Manager, State};

pub struct AppState {
    /// 写入后记录的（路径 → mtime），用于抑制监听器对自身写入的回声。
    pub suppress: Mutex<HashMap<String, SystemTime>>,
    pub store: Mutex<store::Store>,
}

#[derive(Serialize)]
pub struct FileSnapshot {
    pub text: String,
    pub mtime: Option<u64>,
}

#[derive(Serialize)]
pub struct TargetsPayload {
    pub home: String,
    pub targets: Vec<targets::TargetInfo>,
}

#[tauri::command]
fn list_targets() -> TargetsPayload {
    TargetsPayload {
        home: targets::home().to_string_lossy().to_string(),
        targets: targets::TARGETS.iter().map(targets::info).collect(),
    }
}

/// 所有命令只接受注册表中的路径：Webview 永远无法借此读取任意文件。
fn resolve_registered(path: &str) -> Result<PathBuf, String> {
    targets::find_by_path(path)
        .map(|t| targets::resolve_path(t.rel))
        .ok_or_else(|| format!("路径不在 Pizzic 注册表中: {path}"))
}

fn mtime_millis(p: &std::path::Path) -> Option<u64> {
    std::fs::metadata(p)
        .ok()?
        .modified()
        .ok()?
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

#[tauri::command]
fn read_file(path: String) -> Result<FileSnapshot, String> {
    let p = resolve_registered(&path)?;
    let text = std::fs::read_to_string(&p).map_err(|e| format!("读取失败: {e}"))?;
    Ok(FileSnapshot {
        text,
        mtime: mtime_millis(&p),
    })
}

#[tauri::command]
fn write_file(app: AppHandle, path: String, text: String) -> Result<FileSnapshot, String> {
    let p = resolve_registered(&path)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    // 先写临时文件再原子替换，避免留下半截文件。
    let mut persisted = false;
    if let (Some(dir), Some(name)) = (p.parent(), p.file_name()) {
        if let Ok(mut tf) = tempfile::NamedTempFile::new_in(dir) {
            if tf.write_all(text.as_bytes()).is_ok() {
                let target = dir.join(name);
                if tf.persist(&target).is_ok() {
                    persisted = true;
                }
            }
        }
    }
    if !persisted {
        std::fs::write(&p, text.as_bytes()).map_err(|e| format!("写入失败: {e}"))?;
    }

    let mtime = std::fs::metadata(&p)
        .and_then(|m| m.modified())
        .unwrap_or_else(|_| SystemTime::now());
    let state = app.state::<AppState>();
    state
        .suppress
        .lock()
        .unwrap()
        .insert(p.to_string_lossy().to_lowercase(), mtime);

    Ok(FileSnapshot {
        text,
        mtime: mtime_millis(&p),
    })
}

#[tauri::command]
fn get_disabled_modules(
    state: State<AppState>,
    path: String,
) -> Result<HashMap<String, store::ArchivedEntry>, String> {
    Ok(state.store.lock().unwrap().get(&path))
}

#[tauri::command]
fn set_disabled_module(
    state: State<AppState>,
    path: String,
    name: String,
    content: Option<String>,
    after: Option<String>,
) -> Result<(), String> {
    state.store.lock().unwrap().set(&path, &name, content, after)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let config_dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("pizzic"));
            std::fs::create_dir_all(&config_dir).ok();
            app.manage(AppState {
                suppress: Mutex::new(HashMap::new()),
                store: Mutex::new(store::Store::load(&config_dir)),
            });
            watch::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_targets,
            read_file,
            write_file,
            get_disabled_modules,
            set_disabled_module
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
