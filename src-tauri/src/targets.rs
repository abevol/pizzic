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
        rels: &[".agents/AGENTS.md"],
        create_rel: ".agents/AGENTS.md",
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

/// 目标当前生效的路径：候选中第一个存在的文件（override 优先）；
/// 都不存在时为主指令文件（create_rel，新建目标文件时即用它）。
pub fn effective_path(def: &TargetDef) -> PathBuf {
    for rel in def.rels {
        let p = resolve_path(rel);
        if p.is_file() {
            return p;
        }
    }
    resolve_path(def.create_rel)
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

pub fn info(def: &TargetDef) -> TargetInfo {
    let p = effective_path(def);
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
