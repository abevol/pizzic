use crate::store::Store;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// 私有共享指令文件：Pizzic 独占，避免与其他工具争用 `~/.agents/AGENTS.md`。
pub const SHARED_REL: &str = ".pizzic/AGENTS.md";
/// 旧共享路径：只作为一次性迁移来源，不再出现在目标注册表中。
pub const LEGACY_SHARED_REL: &str = ".agents/AGENTS.md";

pub fn shared_path() -> PathBuf {
    crate::targets::resolve_path(SHARED_REL)
}

pub fn legacy_shared_path() -> PathBuf {
    crate::targets::resolve_path(LEGACY_SHARED_REL)
}

/// 启动时发生过迁移时随 `list_targets` 一次性投递给前端，用于建议删除旧文件。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MigrationInfo {
    pub legacy_path: String,
    pub shared_path: String,
    pub copied_bytes: u64,
}

/// 启动时维护私有共享指令文件的可用性：
///
/// - 私有路径已被占用（普通文件或符号链接）→ 不动，交给目标状态机处理；
/// - 缺失且旧文件存在 → 复制内容，并把旧路径下的停用存档并入新路径；
/// - 缺失且旧文件也不存在 → 建空白文件。
///
/// 不设迁移标记（ADR-005）：复制只在私有文件缺失时发生，删掉旧文件即
/// 切断复制来源，不会出现「删了又复活」。
pub fn bootstrap(store: &mut Store) -> Option<MigrationInfo> {
    bootstrap_at(store, &legacy_shared_path(), &shared_path())
}

/// `bootstrap` 的可测试内核：显式传入新旧路径，不依赖真实主目录。
pub fn bootstrap_at(store: &mut Store, legacy: &Path, new: &Path) -> Option<MigrationInfo> {
    if fs::symlink_metadata(new).is_ok() {
        return None;
    }

    if fs::metadata(legacy).map(|m| m.is_file()).unwrap_or(false) {
        if let Some(dir) = new.parent() {
            if let Err(e) = fs::create_dir_all(dir) {
                eprintln!("[pizzic] 创建共享指令目录失败: {e}");
                return None;
            }
        }
        match fs::copy(legacy, new) {
            Ok(bytes) => {
                if let Err(e) = store.merge_missing(&legacy.to_string_lossy(), &new.to_string_lossy())
                {
                    eprintln!("[pizzic] 合并停用存档失败: {e}");
                }
                return Some(MigrationInfo {
                    legacy_path: legacy.to_string_lossy().to_string(),
                    shared_path: new.to_string_lossy().to_string(),
                    copied_bytes: bytes,
                });
            }
            Err(e) => {
                // 不建空白文件：保留「缺失」状态，让下次启动重试复制，避免迁移被悄悄放弃。
                eprintln!("[pizzic] 复制旧共享指令失败（下次启动重试）: {e}");
                return None;
            }
        }
    }

    if let Some(dir) = new.parent() {
        let _ = fs::create_dir_all(dir);
        if let Err(e) = fs::write(new, b"") {
            eprintln!("[pizzic] 创建共享指令文件失败: {e}");
        }
    }
    None
}

/// 确保共享指令文件存在（目录随之创建）。返回是否新建了文件。
/// 路径被目录占用时报错；被符号链接占用时视为已存在，由目标状态机呈现。
pub fn ensure_shared_file() -> Result<bool, String> {
    let p = shared_path();
    if let Ok(meta) = fs::symlink_metadata(&p) {
        if meta.is_dir() {
            return Err(format!("共享指令路径被目录占用: {}", p.display()));
        }
        return Ok(false);
    }
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建共享指令目录失败: {e}"))?;
    }
    fs::write(&p, b"").map_err(|e| format!("创建共享指令文件失败: {e}"))?;
    Ok(true)
}

#[cfg(windows)]
pub fn create_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(target, link)
}

#[cfg(unix)]
pub fn create_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

pub fn symlink_error(e: std::io::Error) -> String {
    // Windows 未开启开发者模式且非管理员时，CreateSymbolicLink 报 ERROR_PRIVILEGE_NOT_HELD(1314)。
    if e.raw_os_error() == Some(1314) {
        "创建符号链接被系统拒绝：请开启 Windows 开发者模式，或以管理员身份运行 Pizzic".to_string()
    } else {
        format!("创建符号链接失败: {e}")
    }
}

/// 链接是否指向 `shared`（按文件身份比较：其他链接、相对目标、`..` 都能识别）。
pub fn link_points_to(link: &Path, shared: &Path) -> bool {
    fs::read_link(link)
        .map(|t| crate::targets::same_path(&crate::targets::absolutize_link_target(link, &t), shared))
        .unwrap_or(false)
}

/// 把路径移入系统回收站（可在资源管理器中还原），不永久删除。
///
/// 链接只回收链接本身：`trash` 只规范化父目录再拼回文件名，不跟随链接目标。
/// 悬空链接可能无法被 Shell 解析、进不了回收站；链接不承载内容，删除它不涉及
/// 数据丢失，故仅对这一种情形退回直接删除链接（修复坏链接的必要出口）。
pub fn trash_path(p: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(p).map_err(|e| format!("目标文件不存在: {e}"))?;
    let is_link = meta.file_type().is_symlink();
    if meta.is_dir() && !is_link {
        return Err("目标路径是目录，拒绝删除".to_string());
    }

    // `trash` 首次调用会对当前线程 CoInitializeEx(STA)，线程已是 MTA 时 panic
    // （release 下 panic=abort 会终止应用）。独立线程执行，使初始化状态可控。
    let owned = p.to_path_buf();
    let joined = std::thread::spawn(move || trash::delete(&owned)).join();
    match joined {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => {
            let dangling = fs::metadata(p).is_err();
            if is_link && dangling && fs::remove_file(p).is_ok() {
                return Ok(());
            }
            Err(format!("移入回收站失败: {e}"))
        }
        Err(_) => Err("移入回收站失败: 回收站操作线程异常".to_string()),
    }
}

/// 把一个路径变成指向共享指令文件的符号链接。返回原普通文件是否被移入回收站。
///
/// 三种形态：普通文件先移入回收站再替换，指向别处的链接直接改指向（链接不
/// 承载内容，无需回收），缺失路径直接创建；已正确指向者幂等返回。
///
/// 顺序是先建临时链接、再处理原文件、最后 `rename` 就位：创建链接的权限问题
/// 会让操作在**触及原文件之前**失败；原文件进回收站后可随时还原，`rename`
/// 失败也不会造成不可逆的数据丢失。
pub fn link_path(target: &Path, shared: &Path) -> Result<bool, String> {
    link_path_with(target, shared, trash_path)
}

fn link_path_with(
    target: &Path,
    shared: &Path,
    dispose: impl Fn(&Path) -> Result<(), String>,
) -> Result<bool, String> {
    let smeta = fs::symlink_metadata(target).ok();
    let mut replace_regular = false;
    if let Some(meta) = &smeta {
        if meta.is_dir() {
            return Err(format!("目标路径是目录，无法创建符号链接: {}", target.display()));
        }
        if meta.file_type().is_symlink() {
            if link_points_to(target, shared) && fs::metadata(target).is_ok() {
                return Ok(false);
            }
        } else {
            replace_regular = true;
        }
    }

    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let tmp = temp_link_path(target);
    create_file_symlink(shared, &tmp).map_err(symlink_error)?;

    if replace_regular {
        if let Err(e) = dispose(target) {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
    }
    if let Err(e) = fs::rename(&tmp, target) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("替换为符号链接失败（原文件已在回收站，可还原）: {e}"));
    }
    Ok(replace_regular)
}

fn temp_link_path(target: &Path) -> PathBuf {
    let dir = target.parent().unwrap_or_else(|| Path::new("."));
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    dir.join(format!(".pizzic-link-{}-{stamp}.tmp", std::process::id()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch(tag: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!("pizzic-{tag}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn write(p: &Path, text: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    #[test]
    fn migrates_legacy_and_merges_archives() {
        let root = scratch("migrate");
        let legacy = root.join(".agents/AGENTS.md");
        let new = root.join(".pizzic/AGENTS.md");
        write(&legacy, "legacy-content");

        let mut store = Store::load(&root.join("config"));
        store
            .set(&legacy.to_string_lossy(), "old-only", Some("A".into()), None)
            .unwrap();
        store
            .set(&legacy.to_string_lossy(), "shared-name", Some("legacy".into()), None)
            .unwrap();
        store
            .set(&new.to_string_lossy(), "shared-name", Some("new".into()), None)
            .unwrap();

        let info = bootstrap_at(&mut store, &legacy, &new).expect("应发生迁移");
        assert_eq!(fs::read(&new).unwrap(), b"legacy-content");
        assert_eq!(info.copied_bytes, 14);
        assert!(legacy.exists(), "旧文件保留，删除由用户决定");

        let merged = store.get(&new.to_string_lossy());
        assert_eq!(merged.get("old-only").unwrap().content, "A");
        assert_eq!(
            merged.get("shared-name").unwrap().content,
            "new",
            "同名条目以新路径已有者为准"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn existing_private_file_wins() {
        let root = scratch("keep");
        let legacy = root.join(".agents/AGENTS.md");
        let new = root.join(".pizzic/AGENTS.md");
        write(&legacy, "legacy-content");
        write(&new, "private-content");

        let mut store = Store::load(&root.join("config"));
        assert!(bootstrap_at(&mut store, &legacy, &new).is_none());
        assert_eq!(fs::read(&new).unwrap(), b"private-content");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn creates_blank_file_when_nothing_exists() {
        let root = scratch("blank");
        let new = root.join(".pizzic/AGENTS.md");
        let mut store = Store::load(&root.join("config"));

        assert!(bootstrap_at(&mut store, &root.join(".agents/AGENTS.md"), &new).is_none());
        assert_eq!(fs::read(&new).unwrap(), b"");

        let _ = fs::remove_dir_all(&root);
    }

    fn symlinks_available(shared: &Path, dir: &Path) -> bool {
        let probe = dir.join("probe.lnk");
        match create_file_symlink(shared, &probe) {
            Ok(()) => {
                let _ = fs::remove_file(&probe);
                true
            }
            Err(e) => {
                // 未开启开发者模式的环境无法创建符号链接：跳过而不是误报失败。
                eprintln!("跳过符号链接测试：{e}");
                false
            }
        }
    }

    #[test]
    fn link_path_trashes_original_and_retargets_links() {
        let root = scratch("link");
        let shared = root.join("shared/AGENTS.md");
        write(&shared, "SHARED");
        let dir = root.join("agent");
        fs::create_dir_all(&dir).unwrap();
        if !symlinks_available(&shared, &dir) {
            let _ = fs::remove_dir_all(&root);
            return;
        }
        let target = dir.join("CLAUDE.md");
        // 测试用「回收站」：记录被回收的路径并从原位置移除，不触碰真实回收站。
        let trashed = std::cell::RefCell::new(Vec::new());
        let dispose = |p: &Path| {
            trashed.borrow_mut().push(p.to_path_buf());
            fs::remove_file(p).map_err(|e| format!("移除失败: {e}"))
        };

        // 缺失 → 建链接，没有原文件要回收
        assert!(!link_path_with(&target, &shared, &dispose).unwrap());
        assert!(fs::symlink_metadata(&target)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(&target).unwrap(), b"SHARED");
        assert!(trashed.borrow().is_empty());

        // 已正确指向 → 幂等，不回收任何东西
        assert!(!link_path_with(&target, &shared, &dispose).unwrap());
        assert!(trashed.borrow().is_empty());

        // 普通文件 → 原文件被移入回收站，链接就位
        fs::remove_file(&target).unwrap();
        fs::write(&target, b"ORIGINAL").unwrap();
        assert!(
            link_path_with(&target, &shared, &dispose).unwrap(),
            "普通文件转换应报告已回收原文件"
        );
        assert_eq!(*trashed.borrow(), vec![target.clone()]);
        assert_eq!(fs::read(&target).unwrap(), b"SHARED");

        // 指向别处 → 改指向，链接不承载内容，无需回收
        let other = dir.join("other.md");
        fs::write(&other, b"OTHER").unwrap();
        fs::remove_file(&target).unwrap();
        create_file_symlink(&other, &target).unwrap();
        assert!(!link_path_with(&target, &shared, &dispose).unwrap());
        assert_eq!(fs::read(&target).unwrap(), b"SHARED");
        assert_eq!(trashed.borrow().len(), 1, "改指向不新增回收");
        assert!(other.exists(), "旧目标文件不受影响");

        // 悬空链接 → 可直接改指向
        fs::remove_file(&target).unwrap();
        create_file_symlink(&dir.join("missing.md"), &target).unwrap();
        assert!(!link_path_with(&target, &shared, &dispose).unwrap());
        assert_eq!(fs::read(&target).unwrap(), b"SHARED");

        // 目录占位 → 报错
        let occupied = dir.join("occupied");
        fs::create_dir_all(&occupied).unwrap();
        assert!(link_path_with(&occupied, &shared, &dispose).is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn link_path_keeps_original_when_dispose_fails() {
        let root = scratch("link-fail");
        let shared = root.join("shared/AGENTS.md");
        write(&shared, "SHARED");
        let dir = root.join("agent");
        fs::create_dir_all(&dir).unwrap();
        if !symlinks_available(&shared, &dir) {
            let _ = fs::remove_dir_all(&root);
            return;
        }
        let target = dir.join("CLAUDE.md");
        fs::write(&target, b"KEEP").unwrap();

        let failing = |_: &Path| Err::<(), String>("模拟回收站不可用".to_string());
        assert!(link_path_with(&target, &shared, &failing).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"KEEP", "回收失败时原文件不受影响");
        assert!(!fs::symlink_metadata(&target)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(
            !fs::read_dir(&dir)
                .unwrap()
                .filter_map(|e| e.ok())
                .any(|e| e.file_name().to_string_lossy().starts_with(".pizzic-link-")),
            "失败时临时链接应被清理"
        );

        let _ = fs::remove_dir_all(&root);
    }
}
