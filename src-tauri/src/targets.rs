use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetKind {
    Shared,
    Agent,
}

/// 对前端暴露的目标状态。`exists` 表示**路径被占用**（含悬空符号链接），
/// 与「可读取到内容」解耦：悬空链接不会让候选序列跳过它，也不会露出创建按钮。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetInfo {
    pub id: String,
    pub label: String,
    pub kind: TargetKind,
    /// 当前生效路径（候选中第一个被占用者）。
    pub path: String,
    /// 全部候选路径（含未生效者）：前端据此判断外部事件是否影响该目标。
    pub paths: Vec<String>,
    pub exists: bool,
    pub size: Option<u64>,
    pub mtime: Option<u64>,
    pub is_link: bool,
    /// 符号链接目标（已按链接所在目录绝对化，保留原始形态不做 canonicalize）。
    pub link_target: Option<String>,
    /// 跟随链接后可读到文件内容。
    pub link_target_exists: bool,
    /// 目标解析后就是 Pizzic 私有共享指令文件（允许经由其他链接、`..` 到达）。
    pub link_target_is_shared: bool,
}

pub struct TargetDef {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: TargetKind,
    /// 候选文件（相对用户主目录，统一 `/` 分隔），按 Agent 的实际读取优先级
    /// 排列：第一个存在者生效（firstThere，路径规则源自 magpie 的 targetOf）。
    /// 支持 override 的 Agent（codex/pi/omo/stepcode）把 override 文件放在
    /// 首位——它就是最高优先级的候选，无需单独警示。Pi/OmO/Prime/StepCode
    /// 的 AGENTS.MD/CLAUDE.MD 大小写变体在 Windows 上与同名小写文件相同，
    /// 折叠不列。
    pub rels: &'static [&'static str],
    /// 目标文件不存在时的创建路径（= 该 Agent 的主指令文件）。
    pub create_rel: &'static str,
}

/// 用户级指令文件目标。路径规则来源：magpie `internal/library/targets.go`；
/// 排除：Grok App（路径依赖 config.toml 解析）、WSL 变体（notify 对 UNC 不可靠）、
/// 插件 Agent（动态声明）、无用户级指令文件者。
pub const TARGETS: &[TargetDef] = &[
    TargetDef {
        id: "shared",
        label: "共享指令",
        kind: TargetKind::Shared,
        rels: &[crate::shared::SHARED_REL],
        create_rel: crate::shared::SHARED_REL,
    },
    TargetDef {
        id: "claude",
        label: "Claude Code",
        kind: TargetKind::Agent,
        rels: &[".claude/CLAUDE.md"],
        create_rel: ".claude/CLAUDE.md",
    },
    TargetDef {
        id: "codex",
        label: "Codex",
        kind: TargetKind::Agent,
        rels: &[".codex/AGENTS.override.md", ".codex/AGENTS.md"],
        create_rel: ".codex/AGENTS.md",
    },
    TargetDef {
        id: "gemini",
        label: "Gemini CLI",
        kind: TargetKind::Agent,
        rels: &[".gemini/GEMINI.md"],
        create_rel: ".gemini/GEMINI.md",
    },
    TargetDef {
        id: "agy",
        label: "Antigravity",
        kind: TargetKind::Agent,
        rels: &[".gemini/config/GEMINI.md"],
        create_rel: ".gemini/config/GEMINI.md",
    },
    TargetDef {
        id: "opencode",
        label: "OpenCode",
        kind: TargetKind::Agent,
        rels: &[".config/opencode/AGENTS.md"],
        create_rel: ".config/opencode/AGENTS.md",
    },
    TargetDef {
        id: "deveco",
        label: "DevEco Code",
        kind: TargetKind::Agent,
        rels: &[".config/deveco/AGENTS.md"],
        create_rel: ".config/deveco/AGENTS.md",
    },
    TargetDef {
        id: "mimocode",
        label: "MiMo Code",
        kind: TargetKind::Agent,
        rels: &[".config/mimocode/AGENTS.md"],
        create_rel: ".config/mimocode/AGENTS.md",
    },
    TargetDef {
        id: "pi",
        label: "Pi",
        kind: TargetKind::Agent,
        rels: &[
            ".pi/agent/AGENTS.override.md",
            ".pi/agent/AGENTS.md",
            ".pi/agent/CLAUDE.md",
        ],
        create_rel: ".pi/agent/AGENTS.md",
    },
    TargetDef {
        id: "dsh",
        label: "DeepSeek Harness",
        kind: TargetKind::Agent,
        rels: &[".dsh/AGENTS.md"],
        create_rel: ".dsh/AGENTS.md",
    },
    TargetDef {
        id: "omp",
        label: "omp",
        kind: TargetKind::Agent,
        rels: &[".omp/agent/AGENTS.md"],
        create_rel: ".omp/agent/AGENTS.md",
    },
    TargetDef {
        id: "omo",
        label: "OmO",
        kind: TargetKind::Agent,
        rels: &[
            ".omo/agent/AGENTS.override.md",
            ".omo/agent/AGENTS.md",
            ".omo/agent/CLAUDE.md",
        ],
        create_rel: ".omo/agent/AGENTS.md",
    },
    TargetDef {
        id: "goose",
        label: "Goose",
        kind: TargetKind::Agent,
        rels: &[".config/goose/.goosehints"],
        create_rel: ".config/goose/.goosehints",
    },
    TargetDef {
        id: "copilot",
        label: "Copilot CLI",
        kind: TargetKind::Agent,
        rels: &[".copilot/copilot-instructions.md"],
        create_rel: ".copilot/copilot-instructions.md",
    },
    TargetDef {
        id: "crush",
        label: "Crush",
        kind: TargetKind::Agent,
        rels: &[".config/crush/CRUSH.md"],
        create_rel: ".config/crush/CRUSH.md",
    },
    TargetDef {
        id: "zcode",
        label: "ZCode",
        kind: TargetKind::Agent,
        rels: &[".zcode/AGENTS.md"],
        create_rel: ".zcode/AGENTS.md",
    },
    TargetDef {
        id: "kimi",
        label: "Kimi Code",
        kind: TargetKind::Agent,
        rels: &[".kimi-code/AGENTS.md"],
        create_rel: ".kimi-code/AGENTS.md",
    },
    TargetDef {
        id: "alma",
        label: "Alma",
        kind: TargetKind::Agent,
        rels: &[".config/alma/USER.md"],
        create_rel: ".config/alma/USER.md",
    },
    TargetDef {
        id: "devin",
        label: "Devin CLI",
        kind: TargetKind::Agent,
        rels: &[".config/devin/AGENTS.md", ".config/devin/AGENT.md"],
        create_rel: ".config/devin/AGENTS.md",
    },
    TargetDef {
        id: "grok",
        label: "Grok Build",
        kind: TargetKind::Agent,
        rels: &[".grok/AGENTS.md"],
        create_rel: ".grok/AGENTS.md",
    },
    TargetDef {
        id: "droid",
        label: "Droid",
        kind: TargetKind::Agent,
        rels: &[".factory/AGENTS.md"],
        create_rel: ".factory/AGENTS.md",
    },
    TargetDef {
        id: "qoder",
        label: "Qoder",
        kind: TargetKind::Agent,
        rels: &[".qoder/AGENTS.md"],
        create_rel: ".qoder/AGENTS.md",
    },
    TargetDef {
        id: "qoder-cn",
        label: "Qoder CN",
        kind: TargetKind::Agent,
        rels: &[".qoder-cn/AGENTS.md"],
        create_rel: ".qoder-cn/AGENTS.md",
    },
    TargetDef {
        id: "codebuddy",
        label: "CodeBuddy Code",
        kind: TargetKind::Agent,
        rels: &[".codebuddy/CODEBUDDY.md", ".codebuddy/CODEBUDDY.mdc"],
        create_rel: ".codebuddy/CODEBUDDY.md",
    },
    TargetDef {
        id: "fx",
        label: "fx",
        kind: TargetKind::Agent,
        rels: &[".fx/AGENTS.md"],
        create_rel: ".fx/AGENTS.md",
    },
    TargetDef {
        id: "prime-agent",
        label: "Prime Agent",
        kind: TargetKind::Agent,
        rels: &[
            ".prime/agent/AGENTS.override.md",
            ".prime/agent/AGENTS.md",
            ".prime/agent/CLAUDE.md",
        ],
        create_rel: ".prime/agent/AGENTS.md",
    },
    TargetDef {
        id: "stepcode",
        label: "StepCode",
        kind: TargetKind::Agent,
        rels: &[
            ".stepcode/agent/AGENTS.override.md",
            ".stepcode/agent/AGENTS.md",
            ".stepcode/agent/CLAUDE.md",
        ],
        create_rel: ".stepcode/agent/AGENTS.md",
    },
    TargetDef {
        id: "jcode",
        label: "jcode",
        kind: TargetKind::Agent,
        rels: &[".jcode/prompt-overlay.md"],
        create_rel: ".jcode/prompt-overlay.md",
    },
    TargetDef {
        id: "atomcode",
        label: "AtomCode",
        kind: TargetKind::Agent,
        rels: &[".atomcode/ATOMCODE.md"],
        create_rel: ".atomcode/ATOMCODE.md",
    },
    TargetDef {
        id: "qwen",
        label: "Qwen Code",
        kind: TargetKind::Agent,
        rels: &[".qwen/QWEN.md"],
        create_rel: ".qwen/QWEN.md",
    },
    TargetDef {
        id: "reasonix",
        label: "Reasonix",
        kind: TargetKind::Agent,
        rels: &[".reasonix/REASONIX.md"],
        create_rel: ".reasonix/REASONIX.md",
    },
];

pub fn home() -> PathBuf {
    dirs::home_dir().expect("无法定位用户主目录")
}

pub fn resolve_path(rel: &str) -> PathBuf {
    let mut p = home();
    for part in rel.split('/') {
        p.push(part);
    }
    p
}

/// 目标当前生效的路径：候选中第一个**被占用**的文件（override 优先）；
/// 都不存在时为主指令文件（create_rel，新建目标文件时即用它）。
/// 占用含悬空符号链接：链接本身就是该 Agent 的指令文件占位，不应被越过。
pub fn effective_path(def: &TargetDef) -> PathBuf {
    for rel in def.rels {
        let p = resolve_path(rel);
        if is_occupied(&p) {
            return p;
        }
    }
    resolve_path(def.create_rel)
}

pub fn is_occupied(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok()
}

/// 路径白名单：只接受命中某个目标某个候选的路径（大小写不敏感），
/// 返回解析后的实际路径。Webview 永远无法借此读写任意文件。
pub fn resolve_registered(path: &str) -> Option<PathBuf> {
    let lower = path.trim().to_lowercase();
    for def in TARGETS {
        for rel in def.rels {
            let p = resolve_path(rel);
            if p.to_string_lossy().to_lowercase() == lower {
                return Some(p);
            }
        }
    }
    None
}

/// 词法绝对化：折叠 `.`/`..`，不访问文件系统。相对路径按 `base` 目录解析。
pub fn absolutize(base: &Path, p: &Path) -> PathBuf {
    let joined = if p.is_absolute() { p.to_path_buf() } else { base.join(p) };
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(c.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(s) => out.push(s),
        }
    }
    out
}

/// 符号链接的相对目标以链接所在目录为基准。
pub fn absolutize_link_target(link: &Path, target: &Path) -> PathBuf {
    absolutize(link.parent().unwrap_or_else(|| Path::new(".")), target)
}

/// Windows 的 canonicalize 会加 `\\?\` 前缀；比较前剥掉，UNC 形式还原。
fn strip_verbatim(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    p.to_path_buf()
}

/// 字面路径比较：不做 canonicalize（不跟随链接），只折叠 `.`/`..`、统一
/// 分隔符与大小写。用于「这个注册表路径本身是不是共享文件」，避免把指向
/// 共享文件的链接误判成共享文件本身。
pub fn same_literal_path(a: &Path, b: &Path) -> bool {
    let abs = |p: &Path| {
        let joined = if p.is_absolute() {
            p.to_path_buf()
        } else {
            std::env::current_dir().unwrap_or_default().join(p)
        };
        absolutize(Path::new(""), &joined)
            .to_string_lossy()
            .replace('/', "\\")
            .to_lowercase()
    };
    abs(a) == abs(b)
}

/// 文件身份比较：先 canonicalize（解析全部链接与真实大小写），失败则退回
/// 词法绝对化；统一分隔符与大小写后比较。
fn comparable(p: &Path) -> String {
    let resolved = std::fs::canonicalize(p).ok().unwrap_or_else(|| {
        let abs = if p.is_absolute() {
            p.to_path_buf()
        } else {
            std::env::current_dir().unwrap_or_default().join(p)
        };
        absolutize(Path::new(""), &abs)
    });
    strip_verbatim(&resolved)
        .to_string_lossy()
        .replace('/', "\\")
        .to_lowercase()
}

pub fn same_path(a: &Path, b: &Path) -> bool {
    comparable(a) == comparable(b)
}

/// 监听目录：主目录（感知一级目录/文件的新建）+ 每个候选文件的父目录。
/// 只非递归监听，事件噪音小；全部候选所在目录都覆盖，文件内容变化才能真正收到。
pub fn watch_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![home()];
    for def in TARGETS {
        for rel in def.rels {
            if let Some(parent) = resolve_path(rel).parent() {
                dirs.push(parent.to_path_buf());
            }
        }
    }
    dirs.sort();
    dirs.dedup();
    dirs
}

pub fn info(def: &TargetDef) -> TargetInfo {
    let p = effective_path(def);
    let smeta = std::fs::symlink_metadata(&p).ok();
    let is_link = smeta
        .as_ref()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);

    let mut link_target = None;
    let mut link_target_exists = false;
    let mut link_target_is_shared = false;
    if is_link {
        if let Ok(t) = std::fs::read_link(&p) {
            let abs = absolutize_link_target(&p, &t);
            link_target_is_shared = same_path(&abs, &crate::shared::shared_path());
            link_target_exists = std::fs::metadata(&p).map(|m| m.is_file()).unwrap_or(false);
            link_target = Some(abs.to_string_lossy().to_string());
        }
    }

    // 链接自身只暴露链接的元数据：跟随后的 size/mtime 属于目标文件，
    // 外链目标不应通过目标列表泄露（内容读取已由 read_file 拒绝）。
    let meta = if is_link {
        std::fs::symlink_metadata(&p).ok()
    } else {
        std::fs::metadata(&p).ok()
    };
    TargetInfo {
        id: def.id.into(),
        label: def.label.into(),
        kind: def.kind,
        paths: def
            .rels
            .iter()
            .map(|rel| resolve_path(rel).to_string_lossy().to_string())
            .collect(),
        path: p.to_string_lossy().to_string(),
        exists: smeta.is_some(),
        size: meta.as_ref().map(|m| m.len()),
        mtime: meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64),
        is_link,
        link_target,
        link_target_exists,
        link_target_is_shared,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absolutize_folds_relative_segments() {
        let base = Path::new(r"C:\Users\me\.claude");
        assert_eq!(
            absolutize(base, Path::new("../.pizzic/AGENTS.md")),
            PathBuf::from(r"C:\Users\me\.pizzic\AGENTS.md")
        );
    }

    #[test]
    fn same_path_ignores_separator_and_case() {
        let a = Path::new(r"C:\Users\Me\.pizzic\AGENTS.md");
        let b = Path::new("C:/users/me/.pizzic/agents.md");
        assert!(same_path(a, b));
    }

    #[test]
    fn same_path_rejects_different_files() {
        assert!(!same_path(
            Path::new(r"C:\Users\me\.pizzic\AGENTS.md"),
            Path::new(r"C:\Users\me\.agents\AGENTS.md")
        ));
    }

    #[test]
    fn literal_path_is_pure_lexical() {
        assert!(same_literal_path(
            Path::new(r"C:\Users\Me\.pizzic\AGENTS.md"),
            Path::new(r"C:\Users\me\.pizzic\AGENTS.md")
        ));
        assert!(!same_literal_path(
            Path::new(r"C:\Users\me\.pizzic\AGENTS.md"),
            Path::new(r"C:\Users\me\.agents\AGENTS.md")
        ));
    }
}
