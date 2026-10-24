use notify::Watcher;
use serde::Serialize;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::mpsc::RecvTimeoutError;
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Clone)]
pub struct ChangedPayload {
    pub path: String,
}

/// 启动文件监听线程。监听失败时静默重试，监控属于应用职责的一部分，
/// 不能因为一次初始化失败就永久失效。
pub fn start(app: AppHandle) {
    std::thread::spawn(move || loop {
        if let Err(e) = run(&app) {
            eprintln!("[pizzic] 文件监听异常，2 秒后重试: {e}");
            std::thread::sleep(Duration::from_secs(2));
        } else {
            return;
        }
    });
}

fn run(app: &AppHandle) -> notify::Result<()> {
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |res| {
        if let Ok(ev) = res {
            let _ = tx.send(ev);
        }
    })?;

    // 所有目标都直接位于主目录下（OpenCode 是唯一二级目录），因此
    // 只需监听主目录与 ~/.config 两个根，非递归，事件噪音很小。
    let home = crate::targets::home();
    let config = home.join(".config");
    let home_clone = home.clone();
    watcher.watch(&home, notify::RecursiveMode::NonRecursive)?;
    if config.is_dir() {
        watcher.watch(&config, notify::RecursiveMode::NonRecursive)?;
    }

    // (小写路径, 对外展示路径)
    let registry: Vec<(String, String)> = crate::targets::TARGETS
        .iter()
        .map(|t| {
            let p = crate::targets::resolve_path(t.rel);
            (
                p.to_string_lossy().to_lowercase(),
                p.to_string_lossy().to_string(),
            )
        })
        .collect();

    let mut pending: HashSet<PathBuf> = HashSet::new();
    let mut last_rescan = Instant::now();

    loop {
        match rx.recv_timeout(Duration::from_millis(300)) {
            Ok(ev) => {
                for p in ev.paths {
                    pending.insert(p);
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return Ok(()),
        }

        // 周期性补挂监听：~/.config 可能中途才被创建。
        if last_rescan.elapsed() > Duration::from_secs(4) {
            last_rescan = Instant::now();
            let _ = watcher.watch(&home_clone, notify::RecursiveMode::NonRecursive);
            if config.is_dir() {
                let _ = watcher.watch(&config, notify::RecursiveMode::NonRecursive);
            }
        }

        if pending.is_empty() {
            continue;
        }

        let batch: HashSet<PathBuf> = std::mem::take(&mut pending);
        let state = app.state::<crate::AppState>();
        let mut suppress = state.suppress.lock().unwrap();
        for p in batch {
            let lower = p.to_string_lossy().to_lowercase();
            let Some((_, display)) = registry.iter().find(|(k, _)| *k == lower) else {
                continue;
            };
            // 文件被删除时不发事件，前端刷新目标列表即可看到存在性变化。
            let Ok(meta) = std::fs::metadata(&p) else { continue };
            let mtime = meta.modified().unwrap_or(SystemTime::now());
            if let Some(own) = suppress.remove(&lower) {
                if own == mtime {
                    continue;
                }
            }
            let _ = app.emit(
                "pizzic:file-changed",
                ChangedPayload {
                    path: display.clone(),
                },
            );
        }
    }
}
