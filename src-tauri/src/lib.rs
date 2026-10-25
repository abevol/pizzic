mod shared;
mod splash;
mod store;
mod targets;
mod watch;

use serde::Serialize;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;
use tauri::{AppHandle, Manager, State};

pub struct AppState {
    /// 写入后记录的（路径 → mtime），用于抑制监听器对自身写入的回声。
    pub suppress: Mutex<HashMap<String, SystemTime>>,
    pub store: Mutex<store::Store>,
    /// 本次启动是否发生共享指令迁移：随首个 `list_targets` 一次性投递。
    pub migration: Mutex<Option<shared::MigrationInfo>>,
}

#[derive(Serialize)]
pub struct FileSnapshot {
    pub text: String,
    pub mtime: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetsPayload {
    pub home: String,
    pub targets: Vec<targets::TargetInfo>,
    pub migration: Option<shared::MigrationInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkOutcome {
    /// 本次是否顺带创建了原本缺失的共享指令文件。
    pub created_shared: bool,
    /// 原普通指令文件是否已被移入回收站（改指向已有链接时为 false）。
    pub trashed_original: bool,
}

#[tauri::command]
fn list_targets(state: State<AppState>) -> TargetsPayload {
    TargetsPayload {
        home: targets::home().to_string_lossy().to_string(),
        targets: targets::TARGETS.iter().map(targets::info).collect(),
        migration: state.migration.lock().unwrap().take(),
    }
}

/// 所有命令只接受注册表中的路径（含各目标的全部候选文件）：
/// Webview 永远无法借此读取任意文件。
fn resolve_registered(path: &str) -> Result<PathBuf, String> {
    targets::resolve_registered(path)
        .ok_or_else(|| format!("路径不在 Pizzic 注册表中: {path}"))
}

fn mtime_millis(p: &Path) -> Option<u64> {
    std::fs::metadata(p)
        .ok()?
        .modified()
        .ok()?
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

fn is_symlink(p: &Path) -> bool {
    std::fs::symlink_metadata(p)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

/// 链接是否指向私有共享指令文件（允许经由其他链接、相对目标、`..` 到达）。
fn link_points_to_shared(p: &Path) -> bool {
    shared::link_points_to(p, &shared::shared_path())
}

#[tauri::command]
fn read_file(path: String) -> Result<FileSnapshot, String> {
    let p = resolve_registered(&path)?;
    // 白名单只约束链接路径本身；若在注册表路径上放一个指向任意文件的链接，
    // 跟随读取就等于绕过白名单。只有共享指令这一个安全目标允许穿透。
    if is_symlink(&p) && !link_points_to_shared(&p) {
        return Err("符号链接目标不是共享指令文件，Pizzic 不读取其内容".to_string());
    }
    let text = std::fs::read_to_string(&p).map_err(|e| format!("读取失败: {e}"))?;
    Ok(FileSnapshot {
        text,
        mtime: mtime_millis(&p),
    })
}

#[tauri::command]
fn write_file(app: AppHandle, path: String, text: String) -> Result<FileSnapshot, String> {
    let p = resolve_registered(&path)?;
    // 符号链接只读：写入会穿透链接改到目标文件（共享指令或任意外部文件）。
    if is_symlink(&p) {
        return Err("目标文件是符号链接，Pizzic 不会写入链接".to_string());
    }
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

/// 把注册表路径变成指向私有共享指令文件的符号链接。
///
/// 同一个操作覆盖三种入口：不存在的路径直接建链接；普通文件先移入回收站
/// （可还原）再替换；指向别处的链接改指向。三种形态的差异只在原文件处理，
/// 落盘方式一致（临链 + rename 就位），转换不留下不可逆的数据损失。
#[tauri::command]
fn link_to_shared(path: String) -> Result<LinkOutcome, String> {
    let p = resolve_registered(&path)?;
    let shared = shared::shared_path();
    if targets::same_literal_path(&p, &shared) {
        return Err("共享指令文件不能链接到自身".to_string());
    }
    let created_shared = shared::ensure_shared_file()?;
    let trashed_original = shared::link_path(&p, &shared)?;
    Ok(LinkOutcome {
        created_shared,
        trashed_original,
    })
}

/// 删除目标路径本身（移入回收站）：链接只删链接，普通文件删文件；
/// 目标文件与停用存档都不动。
#[tauri::command]
fn delete_target(path: String) -> Result<(), String> {
    let p = resolve_registered(&path)?;
    shared::trash_path(&p)
}

/// 删除迁移前的旧共享指令文件（同样进回收站）。路径写死，不接受前端参数。
#[tauri::command]
fn delete_legacy_shared() -> Result<(), String> {
    let p = shared::legacy_shared_path();
    match std::fs::symlink_metadata(&p) {
        Ok(_) => shared::trash_path(&p),
        Err(_) => Ok(()),
    }
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

/// 前端启动壳已解析：让主窗口出现，并在它画好首帧后撤掉原生启动窗。
///
/// 主窗口在 `tauri.conf.json` 中默认隐藏，只能经由这里（或下面的兜底）显示。
/// 启动窗是置顶的，主窗口先在被它盖住的情况下完成首帧绘制，再由 `hand_off`
/// 撤掉，用户看到的始终是同一个画面，没有空白过渡。
#[tauri::command]
fn app_ready(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
    splash::hand_off();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    splash::preload();

    // 启动窗必须赶在 WebView2 初始化之前出现：主窗口要等它建完，约 1 秒。
    // 尺寸直接读窗口配置，不在 Rust 里另抄一份。
    if let Some(win) = context
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main" && w.create)
    {
        if win.center && win.x.is_none() && win.y.is_none() {
            splash::show(win.width, win.height);
        }
    }

    tauri::Builder::default()
        .setup(|app| {
            let config_dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("pizzic"));
            std::fs::create_dir_all(&config_dir).ok();
            let mut store = store::Store::load(&config_dir);
            // 共享指令在监听启动前就位：迁移复制、空白补建或保留既有文件。
            let migration = shared::bootstrap(&mut store);
            app.manage(AppState {
                suppress: Mutex::new(HashMap::new()),
                store: Mutex::new(store),
                migration: Mutex::new(migration),
            });
            watch::start(app.handle().clone());

            // 兜底：前端脚本异常、或 app_ready 没能送达（例如资源加载失败）时，
            // 窗口不能永久隐身、启动窗也不能一直挂着。
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(3));
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.show();
                }
                splash::hand_off();
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_ready,
            list_targets,
            read_file,
            write_file,
            link_to_shared,
            delete_target,
            delete_legacy_shared,
            get_disabled_modules,
            set_disabled_module
        ])
        .run(context)
        .expect("error while running tauri application");
}
