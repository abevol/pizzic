# Pizzic

**Agent 指令文件工作台** —— 用模块化的方式管理 `AGENTS.md` / `CLAUDE.md` 等 Agent 指令文件：模块可单独启用/停用，内容动态拼接到目标文件，并实时感知外部（Agent 自身）的文件变更。

技术栈：Rust + Tauri v2 + SolidJS + CodeMirror 6。

## 功能

### 模块化管理与动态拼接

任何被 Pizzic 管理的文件中，用注释标签包裹的段落即是一个模块：

```markdown
<!-- Pizzic:begin:codegraph -->
## CodeGraph
（模块正文…）
<!-- Pizzic:end -->
```

- **读出模块名**：解析 begin 标签中的名字，编辑器内按模块着色分区，右侧面板列出全部模块；
- **写入模块名**：新建、重命名模块时由 Pizzic 生成/改写 begin 标签；
- **启用/停用**：停用模块时正文从文件中移除、存档到 Pizzic 本地状态，文件中留下
  `<!-- Pizzic:begin:name disabled -->` 空壳标记位置；重新启用时从存档完整恢复；
- **动态拼接**：右侧「共享模块库」可把 `~/.agents/AGENTS.md` 中的模块一键注入任何 Agent 的私有文件；选区可一键包裹成新模块。

### 多 Agent 指令文件

默认注册（缺失文件可在界面内一键创建）：

| 目标 | 路径 |
| --- | --- |
| 共享指令 | `~/.agents/AGENTS.md` |
| Claude Code | `~/.claude/CLAUDE.md` |
| Codex | `~/.codex/AGENTS.md` |
| OpenCode | `~/.config/opencode/AGENTS.md` |
| DSH | `~/.dsh/AGENTS.md` |
| ZCode | `~/.zcode/AGENTS.md` |

### 实时变更监控

Rust 侧基于 `notify` 监听目标文件；Agent 在运行中改写了指令文件时，Pizzic 会：

- 无本地未保存修改 → 自动重新加载并提示；
- 有本地未保存修改 → 顶部横幅给出「放弃本地修改 / 覆盖磁盘」选择。

Pizzic 自身写入通过 mtime 抑制回声，不会触发重载循环。

## 开发

```bash
npm install
npm run tauri dev      # 桌面应用开发模式
npm run check          # TypeScript 类型检查
npm run selfcheck      # 文档解析器行为自检（Node 原生运行）
npm run tauri build    # 发布构建
```

Rust 后端（`src-tauri/`）只做文件 IO、监听与存档；标签解析与模块操作全部在前端
`src/lib/document.ts`（纯函数，可独立测试）。所有 Tauri 命令仅接受注册表内的路径。

设计决策与格式规范见 [docs/DESIGN.md](docs/DESIGN.md)。
