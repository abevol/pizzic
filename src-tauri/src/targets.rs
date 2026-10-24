use serde::Serialize;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetKind {
    Shared,
    Agent,
}

#[derive(Debug, Clone, Serialize)]
pub struct TargetInfo {
    pub id: String,
    pub label: String,
    pub kind: TargetKind,
    pub path: String,
    pub exists: bool,
    pub size: Option<u64>,
    pub mtime: Option<u64>,
}

pub struct TargetDef {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: TargetKind,
    /// 相对用户主目录的路径（统一使用 `/` 分隔）。
    pub rel: &'static str,
}

pub const TARGETS: &[TargetDef] = &[
    TargetDef {
        id: "shared",
        label: "共享指令",
        kind: TargetKind::Shared,
        rel: ".agents/AGENTS.md",
    },
    TargetDef {
        id: "claude",
        label: "Claude Code",
        kind: TargetKind::Agent,
        rel: ".claude/CLAUDE.md",
    },
    TargetDef {
        id: "codex",
        label: "Codex",
        kind: TargetKind::Agent,
        rel: ".codex/AGENTS.md",
    },
    TargetDef {
        id: "opencode",
        label: "OpenCode",
        kind: TargetKind::Agent,
        rel: ".config/opencode/AGENTS.md",
    },
    TargetDef {
        id: "dsh",
        label: "DSH",
        kind: TargetKind::Agent,
        rel: ".dsh/AGENTS.md",
    },
    TargetDef {
        id: "zcode",
        label: "ZCode",
        kind: TargetKind::Agent,
        rel: ".zcode/AGENTS.md",
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

pub fn find_by_path(path: &str) -> Option<&'static TargetDef> {
    let lower = path.trim().to_lowercase();
    TARGETS
        .iter()
        .find(|t| resolve_path(t.rel).to_string_lossy().to_lowercase() == lower)
}

pub fn info(def: &TargetDef) -> TargetInfo {
    let p = resolve_path(def.rel);
    let meta = std::fs::metadata(&p).ok();
    TargetInfo {
        id: def.id.into(),
        label: def.label.into(),
        kind: def.kind,
        path: p.to_string_lossy().to_string(),
        exists: meta.is_some(),
        size: meta.as_ref().map(|m| m.len()),
        mtime: meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64),
    }
}
