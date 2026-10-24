use notify::Watcher;
use serde::Serialize;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::mpsc::RecvTimeoutError;
use std::time::{Duration, Instant};
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

/// 补挂新增目录的监听。目标目录可能中途才被创建（首次使用某个 Agent），
/// 已监听的目录不再重复 watch，避免重复事件。
fn ensure_watches(watcher: &mut notify::RecommendedWatcher, watched: &mut HashSet<PathBuf>) {
    watched.retain(|dir| dir.is_dir());
    for dir in crate::targets::watch_dirs() {
        if watched.contains(&dir) || !dir.is_dir() {
            continue;
        }
        if watcher
            .watch(&dir, notify::RecursiveMode::NonRecursive)
            .is_ok()
        {
            watched.insert(dir);
        }
    }
}

fn run(app: &AppHandle) -> notify::Result<()> {
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |res| {
        if let Ok(ev) = res {
            let _ = tx.send(ev);
        }
    })?;

    let mut watched: HashSet<PathBuf> = HashSet::new();
    ensure_watches(&mut watcher, &mut watched);

    // (小写路径, 对外展示路径)：覆盖每个目标的全部候选文件
    let registry: Vec<(String, String)> = crate::targets::TARGETS
        .iter()
        .flat_map(|t| {
            t.rels.iter().map(|rel| {
                let p = crate::targets::resolve_path(rel);
                (
                    p.to_string_lossy().to_lowercase(),
                    p.to_string_lossy().to_string(),
                )
            })
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

        if last_rescan.elapsed() > Duration::from_secs(4) {
            last_rescan = Instant::now();
            ensure_watches(&mut watcher, &mut watched);
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
            // 用 symlink_metadata：悬空链接仍算占位存在；文件被删除时也要发事件，
            // 否则前端无法感知消失（侧栏分组与编辑器空态都依赖它）。
            let modified = std::fs::symlink_metadata(&p)
                .and_then(|m| m.modified())
                .ok();
            let own = suppress.remove(&lower);
            if let (Some(own), Some(modified)) = (own, modified) {
                if own == modified {
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
