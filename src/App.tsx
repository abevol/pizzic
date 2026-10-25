import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import type { EditorView } from "@codemirror/view";
import {
  api,
  type ArchivedEntry,
  type FileSnapshot,
  type MigrationInfo,
  type TargetInfo,
} from "./lib/api";
import {
  appendModuleEdit,
  applyEdits,
  deleteEdit,
  insertAfterModuleEdit,
  makeModuleBlock,
  moduleHue,
  moduleLabel,
  nextModuleName,
  parseDoc,
  renameEdit,
  wrapSelectionEdits,
  type Edit,
  type ModuleSeg,
} from "./lib/document";
import { createEditor, replaceDoc, setReadOnly } from "./lib/editor";
import { TitleBar } from "./components/TitleBar";
import { Sidebar, shortPath } from "./components/Sidebar";
import { ModulePanel, type ArchivedModule, type LibraryEntry, type PanelModule } from "./components/ModulePanel";
import { StatusBar, type StatusFlash } from "./components/StatusBar";
import { ConfirmModal, type ConfirmSpec } from "./components/ConfirmModal";

function samePath(a: string, b: string): boolean {
  return a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();
}

function starterContent(t: TargetInfo): string {
  const body =
    `这里是 ${t.label} 的第一个指令模块示例。\n\n` +
    "一对 pizzic-module 语义标签包裹的段落是一个模块：name 属性即模块名。" +
    "停用会把模块从文件中移除并存档在 Pizzic 中（可随时恢复到原位）；" +
    '写入 enabled="false" 的旧式空壳同样被识别为停用。';
  return `# ${t.label} 指令\n\n${makeModuleBlock("welcome", body)}`;
}

function firstHeading(text: string): string | null {
  const m = text.match(/^#{1,6}\s+(.+?)\s*$/m);
  return m ? m[1]!.trim() : null;
}

export default function App() {
  const [homeDir, setHomeDir] = createSignal("");
  const [targets, setTargets] = createSignal<TargetInfo[]>([]);
  const [currentId, setCurrentId] = createSignal<string | null>(null);
  const [disk, setDisk] = createSignal<FileSnapshot | null>(null);
  const [dirty, setDirty] = createSignal(false);
  const [archived, setArchived] = createSignal<Record<string, ArchivedEntry>>({});
  const [modules, setModules] = createSignal<ModuleSeg[]>([]);
  const [hasSelection, setHasSelection] = createSignal(false);
  /** 外部冲突：conflict = 普通文件被改动且本地有未保存修改；link = 文件已变为符号链接。 */
  const [externalMode, setExternalMode] = createSignal<"conflict" | "link" | null>(null);
  const [status, setStatus] = createSignal<StatusFlash | null>(null);
  const [stats, setStats] = createSignal({ lines: 0, chars: 0 });
  const [sharedLib, setSharedLib] = createSignal<LibraryEntry[] | null>(null);
  const [confirm, setConfirm] = createSignal<ConfirmSpec | null>(null);
  const [lineEnding, setLineEnding] = createSignal<"LF" | "CRLF" | null>(null);
  const [encoding, setEncoding] = createSignal<string | null>(null);

  let editorHost!: HTMLDivElement;
  let view: EditorView | null = null;
  let pendingSelect: string | null = null;
  let pendingMigration: MigrationInfo | null = null;
  /** 编辑器当前内容的来源形态：聚焦刷新时据此发现「生效路径/形态变了」。 */
  let loadedShape: { id: string; path: string; exists: boolean; isLink: boolean } | null = null;
  let loadSeq = 0;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  const unlisteners: Array<() => void> = [];

  const current = createMemo(() => targets().find((t) => t.id === currentId()) ?? null);
  const currentIsShared = createMemo(() => current()?.kind === "shared");
  const isReadOnly = createMemo(() => current()?.isLink === true);
  const linkIsBroken = createMemo(() => current()?.isLink === true && !current()!.linkTargetExists);
  const linkIsForeign = createMemo(() => current()?.isLink === true && !current()!.linkTargetIsShared);
  /** 「只读」标签的提示：说明只读原因与去哪里改内容。 */
  const readonlyHint = createMemo(() => {
    const t = current();
    if (!t?.isLink) return "";
    if (!t.linkTargetExists) return "链接目标不存在";
    if (t.linkTargetIsShared) return "该文件链接至共享指令文件，请进入「共享指令」修改文件内容";
    return "该文件链接至非共享指令文件，Pizzic 不会加载其内容";
  });
  const panelModules = createMemo<PanelModule[]>(() =>
    modules().map((m) => ({
      name: m.name,
      label: moduleLabel(m),
      hue: moduleHue(m.name),
      enabled: m.enabled,
      chars: m.body.replace(/\s+$/, "").length,
    })),
  );

  /** 停用区（存档驱动）：state.json 中有、文档中没有的条目即停用模块（ADR-004）。 */
  const archivedList = createMemo<ArchivedModule[]>(() => {
    const docNames = new Set(modules().map((m) => m.name));
    return Object.entries(archived())
      .map(([name, e]) => ({
        name,
        hue: moduleHue(name),
        label: firstHeading(e.content) ?? name,
        chars: e.content.replace(/\s+$/, "").length,
      }))
      .filter((e) => !docNames.has(e.name));
  });

  /**
   * 冲突语义（ADR-004 实测修订）：「文档有同名启用模块 + 存档有条目」时存档
   * 一律保留——停用后未保存就重启/切换会精确制造这个组合，立即删档会把
   * 「停用尚未落盘」误判为「外部加回」而丢数据。存档只在明确的用户动作
   * （删除模块、删除存档、重命名迁移、启用恢复）中增删；显示层由
   * archivedList 的过滤让位于文档，悬挂条目无害。
   */

  function flash(text: string, tone: "ok" | "warn" = "ok") {
    setStatus({ text, tone });
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => setStatus(null), 3200);
  }

  /**
   * 编辑器内部（CodeMirror 存储层）永远只保留 LF：实测无论何种配置，
   * CM 都会把 \r\n 归一化为 \n（见 scripts/cm-eol-probe.mjs）。
   * 因此换行模式只在边界处理：dirty 比较对 EOL 归一化，保存时按文件模式还原。
   */
  const normalizeEOL = (s: string) => s.replace(/\r\n?/g, "\n");

  function syncFromEditor() {
    if (!view) return;
    const text = view.state.doc.toString();
    setModules(parseDoc(text).modules);
    const d = disk();
    setDirty(d ? normalizeEOL(text) !== normalizeEOL(d.text) : false);
    setStats({ lines: view.state.doc.lines, chars: text.length });
  }

  /** 把磁盘快照应用进编辑器（文本由 CM 统一为 LF；换行模式仅记录用于保存还原）。 */
  function applySnapshot(snap: FileSnapshot) {
    if (!view) return;
    setLineEnding(/\r\n/.test(snap.text) ? "CRLF" : "LF");
    setEncoding(snap.text.charCodeAt(0) === 0xfeff ? "UTF-8 BOM" : "UTF-8");
    replaceDoc(view, snap.text);
  }

  async function refreshTargets() {
    try {
      const payload = await api.listTargets();
      setHomeDir(payload.home);
      setTargets(payload.targets);
      // 迁移信息只投递一次；留给 onMount 弹框，不在这里打断刷新流程。
      if (payload.migration) pendingMigration = payload.migration;
    } catch (e) {
      flash(String(e), "warn");
    }
  }

  async function loadSharedLib() {
    const shared = targets().find((t) => t.kind === "shared");
    if (!shared || !shared.exists || currentIsShared() || isReadOnly()) {
      setSharedLib([]);
      return;
    }
    try {
      const snap = await api.readFile(shared.path);
      const disabled = await api.getDisabled(shared.path);
      // 库 = 共享文件中的启用模块 + 其存档中的停用模块（ADR-004：停用即不在文档中）
      const entries: LibraryEntry[] = parseDoc(snap.text).modules.map((m) => {
        const body = m.enabled ? m.body : (disabled[m.name]?.content ?? "");
        return { name: m.name, label: moduleLabel(m), body, hasBody: body.trim() !== "", archived: false };
      });
      for (const [name, e] of Object.entries(disabled)) {
        if (entries.some((x) => x.name === name)) continue; // 文档中的版本优先
        entries.push({
          name,
          label: firstHeading(e.content) ?? name,
          body: e.content,
          hasBody: e.content.trim() !== "",
          archived: true,
        });
      }
      setSharedLib(entries);
    } catch {
      setSharedLib([]);
    }
  }

  /** 清空编辑器为「无内容」形态（文件不存在、悬空链接、不可展示的外链）。 */
  function clearView() {
    if (!view) return;
    setDisk(null);
    setDirty(false);
    setArchived({});
    setLineEnding(null);
    setEncoding(null);
    replaceDoc(view, "");
  }

  /**
   * 载入目标。符号链接分三类：
   * - 指向共享指令且目标可读 → 读入其内容（只读预览）；
   * - 指向其他文件 → 不读取内容（保持「Webview 无法借此读取任意文件」的白名单不变量）；
   * - 目标缺失 → 空内容，由横幅给出修复动作。
   */
  async function doLoad(t: TargetInfo) {
    if (!view) return;
    const seq = ++loadSeq;
    setCurrentId(t.id);
    setExternalMode(null);
    loadedShape = { id: t.id, path: t.path, exists: t.exists, isLink: t.isLink };

    if (!t.exists) {
      clearView();
      try {
        const archived = await api.getDisabled(t.path);
        if (seq !== loadSeq) return;
        setArchived(archived);
      } catch {
        if (seq !== loadSeq) return;
        setArchived({});
      }
      void loadSharedLib();
      return;
    }

    if (t.isLink) {
      setArchived({});
      if (t.linkTargetIsShared && t.linkTargetExists) {
        try {
          const snap = await api.readFile(t.path);
          if (seq !== loadSeq) return;
          setDisk(snap);
          setDirty(false);
          applySnapshot(snap);
        } catch (e) {
          if (seq !== loadSeq) return;
          clearView();
          flash(String(e), "warn");
        }
      } else {
        clearView();
      }
      void loadSharedLib();
      return;
    }

    try {
      // 正文与停用存档是两次独立查询：并行取回，别让两次往返依次计入首屏。
      // 存档读取失败只丢存档，不让已读到的正文作废。
      const [snap, archived] = await Promise.all([
        api.readFile(t.path),
        api.getDisabled(t.path).catch(() => ({})),
      ]);
      if (seq !== loadSeq) return;
      setDisk(snap);
      setDirty(false);
      applySnapshot(snap);
      setArchived(archived);
    } catch (e) {
      if (seq !== loadSeq) return;
      clearView();
      flash(String(e), "warn");
    }
    void loadSharedLib();
  }

  async function selectTarget(id: string) {
    if (id === currentId()) return;
    if (dirty()) {
      pendingSelect = id;
      setConfirm({
        title: "有未保存的修改",
        body: "切换文件会丢弃当前未保存的内容。也可以先取消，用 Ctrl+S 保存后再切换。",
        confirmText: "丢弃并切换",
        danger: true,
        onConfirm: () => {
          const t = targets().find((x) => x.id === pendingSelect);
          if (t) void doLoad(t);
        },
      });
      return;
    }
    const t = targets().find((x) => x.id === id);
    if (t) await doLoad(t);
  }

  /** 返回是否真的落盘，转换前需要它来决定是否继续。 */
  async function save(): Promise<boolean> {
    const t = current();
    if (!t || !view) return false;
    if (t.isLink) {
      flash("符号链接只读，无法保存", "warn");
      return false;
    }
    // 编辑器内部是 LF；写盘前按文件实际换行模式还原，保持磁盘文件字节形态。
    const editorText = view.state.doc.toString();
    const text = lineEnding() === "CRLF" ? editorText.replace(/\r?\n/g, "\r\n") : editorText;
    try {
      const snap = await api.writeFile(t.path, text);
      setDisk(snap);
      setDirty(false);
      setExternalMode(null);
      flash(`已保存 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`);
      await refreshTargets();
      return true;
    } catch (e) {
      flash(String(e), "warn");
      return false;
    }
  }

  async function createFile() {
    const t = current();
    if (!t || !view) return;
    try {
      const snap = await api.writeFile(t.path, starterContent(t));
      await refreshTargets();
      loadedShape = { id: t.id, path: t.path, exists: true, isLink: false };
      setDisk(snap);
      setDirty(false);
      applySnapshot(snap);
      flash("文件已创建");
      void loadSharedLib();
    } catch (e) {
      flash(String(e), "warn");
    }
  }

  /**
   * 在空态为缺失的共享指令补内容。只在链接目标是共享文件且悬空时触达：
   * 建空白文件（不写示例模块），随后重载当前视图。
   */
  async function createSharedFile() {
    const shared = targets().find((x) => x.kind === "shared");
    if (!shared) return;
    if (shared.isLink) {
      flash("共享指令文件本身是符号链接，请先在侧栏删除该链接", "warn");
      return;
    }
    try {
      await api.writeFile(shared.path, "");
      await refreshTargets();
      const t = current();
      const updated = t ? targets().find((x) => x.id === t.id) : undefined;
      if (updated) await doLoad(updated);
      flash("已创建共享指令文件");
    } catch (e) {
      flash(String(e), "warn");
    }
  }

  /**
   * 转链接/改指向的唯一入口：不存在 → 直接建；普通文件 → 危险确认（原文件
   * 移入回收站）；指向别处的链接 → 普通确认。指向共享且可读的链接无需动作。
   */
  function requestLink(t: TargetInfo) {
    if (t.kind === "shared") return;
    if (!t.exists) {
      void runLink(t);
      return;
    }
    if (t.isLink && t.linkTargetIsShared) return;
    const shared = targets().find((x) => x.kind === "shared");
    if (t.isLink) {
      setConfirm({
        title: "改指向共享指令",
        body: `该符号链接当前指向 ${
          t.linkTarget ? shortPath(t.linkTarget, homeDir()) : "未知目标"
        }，将改为指向 ${shared ? shortPath(shared.path, homeDir()) : "共享指令文件"}。原目标文件本身不受影响。`,
        confirmText: "改指向",
        onConfirm: () => void runLink(t),
      });
      return;
    }
    const dirtyNow = current()?.id === t.id && dirty();
    setConfirm({
      title: "转换为符号链接",
      body:
        `「${t.label}」的指令文件将被替换为指向共享指令文件的符号链接` +
        `（内容与「共享指令」始终保持一致），当前指令文件将被移入到回收站。` +
        (dirtyNow ? "\n当前未保存的修改会先保存，再随原文件移入回收站。" : ""),
      confirmText: "转换",
      danger: true,
      onConfirm: () => void runLink(t),
    });
  }

  async function runLink(t: TargetInfo) {
    const wasCurrent = currentId() === t.id;
    try {
      // 未保存内容先落盘，随原文件一起进回收站，内容不会丢。
      if (wasCurrent && dirty() && !(await save())) return;
      const outcome = await api.linkToShared(t.path);
      await refreshTargets();
      const updated = targets().find((x) => x.id === t.id);
      if (wasCurrent && updated) await doLoad(updated);
      const notes = [`${t.label} 已指向共享指令`];
      if (outcome.createdShared) notes.push("并补建了空白共享指令文件");
      if (outcome.trashedOriginal) notes.push("原指令文件已移入回收站");
      flash(notes.join("，"));
    } catch (e) {
      flash(String(e), "warn");
    }
  }

  /** 删除按钮的确认策略：链接直接删（只删链接），普通文件危险确认。 */
  function requestDelete(t: TargetInfo) {
    if (!t.exists) return;
    if (t.isLink) {
      void runDelete(t);
      return;
    }
    const dirtyNow = current()?.id === t.id && dirty();
    setConfirm({
      title: "删除指令文件",
      body: `「${t.label}」的指令文件将被移入到回收站。${
        dirtyNow ? "\n当前未保存的修改会一并丢弃。" : ""
      }`,
      confirmText: "移入回收站",
      danger: true,
      onConfirm: () => void runDelete(t),
    });
  }

  async function runDelete(t: TargetInfo) {
    const wasCurrent = currentId() === t.id;
    try {
      await api.deleteTarget(t.path);
      await refreshTargets();
      const updated = targets().find((x) => x.id === t.id);
      if (wasCurrent && updated) await doLoad(updated);
      flash(
        t.isLink
          ? `已删除符号链接 ${t.label}`
          : `已将 ${t.label} 的指令文件移入回收站`,
      );
    } catch (e) {
      flash(String(e), "warn");
    }
  }

  /**
   * 窗口聚焦时的形态兜底：监听事件可能被错过（应用在后台、事件过滤），
   * 只要「已加载形态」与磁盘现状不符就按同一套语义处置：
   * 有未保存修改 → 横幅（链接不给覆盖入口）；否则重新载入。
   */
  async function reconcileShape() {
    const t = targets().find((x) => x.id === currentId());
    if (!t || !loadedShape || loadedShape.id !== t.id) return;
    if (
      t.path === loadedShape.path &&
      t.exists === loadedShape.exists &&
      t.isLink === loadedShape.isLink
    ) {
      return;
    }
    if (dirty()) {
      setExternalMode(t.isLink ? "link" : "conflict");
    } else {
      await doLoad(t);
    }
  }

  function reloadFromDisk() {
    const t = current();
    if (t) void doLoad(t);
  }

  /**
   * 外部变更统一处理：先刷新目标状态，再按**刷新后**的形态决定编辑器的去留。
   * 本地有未保存修改时绝不动缓冲区，只切换横幅语义（符号链接下不给覆盖入口）。
   */
  async function onExternal(changed: string) {
    await refreshTargets();
    const t = targets().find((x) => x.id === currentId());
    const shared = targets().find((x) => x.kind === "shared");
    const touchedBy = (target: TargetInfo) =>
      target.paths.some((p) => samePath(p, changed));

    if (t && view) {
      const isCurrent = touchedBy(t) || (t.isLink && t.linkTargetIsShared && shared && touchedBy(shared));
      if (isCurrent) {
        if (dirty()) {
          setExternalMode(t.isLink ? "link" : "conflict");
        } else {
          await doLoad(t);
          if (t.isLink && t.linkTargetIsShared && t.linkTargetExists) flash("共享指令已更新");
        }
      }
    }
    if (shared && touchedBy(shared)) void loadSharedLib();
  }

  /**
   * 启停统一入口（ADR-004）：停用 = 存档（正文 + 前驱锚）后整块移除；
   * 启用 = 从存档按位置锚插回。文件中的 enabled="false" 旧式壳在启用时一并移除。
   */
  async function toggleModule(name: string) {
    const t = current();
    if (!t || !view) return;
    const text = view.state.doc.toString();
    const mods = parseDoc(text).modules;
    const m = mods.find((x) => x.name === name);

    if (m && m.enabled) {
      const idx = mods.indexOf(m);
      const after = idx > 0 ? mods[idx - 1]!.name : null;
      try {
        await api.setDisabled(t.path, name, m.body, after);
        // 乐观同步本地存档镜像：面板「已停用」分区由该 signal 派生
        setArchived((prev) => ({ ...prev, [name]: { content: m.body, after } }));
        view.dispatch({ changes: [deleteEdit(m, text)] });
        flash(`已停用 ${name}，正文已存档`);
      } catch (e) {
        flash(String(e), "warn");
      }
      return;
    }

    const entry = archived()[name];
    if (!entry) {
      flash(`${name} 没有存档正文，无法启用`, "warn");
      return;
    }
    try {
      await api.setDisabled(t.path, name, null, null);
      setArchived((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
      if (m) {
        // 文件中的停用壳（enabled="false"），先移除再插回正文块
        view.dispatch({ changes: [deleteEdit(m, text)] });
      }
      const base = view.state.doc.toString();
      const edit = entry.after
        ? insertAfterModuleEdit(base, entry.after, name, entry.content)
        : appendModuleEdit(base, name, entry.content);
      view.dispatch({ changes: [edit] });
      flash(`已启用 ${name}`);
    } catch (e) {
      flash(String(e), "warn");
    }
  }

  /** 删除停用存档（停用区行的删除动作），不动文档。 */
  async function deleteArchived(name: string) {
    const t = current();
    if (!t) return;
    try {
      await api.setDisabled(t.path, name, null, null);
      setArchived((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
      flash(`已删除存档 ${name}`);
    } catch (e) {
      flash(String(e), "warn");
    }
  }

  async function removeModule(name: string) {
    const t = current();
    if (!t || !view) return;
    const text = view.state.doc.toString();
    const m = parseDoc(text).modules.find((x) => x.name === name);
    if (!m) return;
    view.dispatch({ changes: [deleteEdit(m, text)] });
    if (archived()[name] !== undefined) {
      try {
        await api.setDisabled(t.path, name, null, null);
        setArchived((prev) => {
          const next = { ...prev };
          delete next[name];
          return next;
        });
      } catch {
        /* 存档清理失败无碍 */
      }
    }
    flash(`已删除 ${name}`);
  }

  async function renameModule(oldName: string, newName: string) {
    const t = current();
    if (!t || !view) return;
    const mods = parseDoc(view.state.doc.toString()).modules;
    if (mods.some((m) => m.name === newName)) {
      flash(`模块名 ${newName} 已存在`, "warn");
      return;
    }
    const m = mods.find((x) => x.name === oldName);
    if (!m) return;
    view.dispatch({ changes: [renameEdit(m, newName)] });
    const stored = archived()[oldName];
    if (stored) {
      try {
        await api.setDisabled(t.path, oldName, null, null);
        await api.setDisabled(t.path, newName, stored.content, stored.after);
        setArchived((prev) => {
          const next = { ...prev };
          delete next[oldName];
          next[newName] = stored;
          return next;
        });
      } catch {
        /* 存档迁移失败无碍 */
      }
    }
    flash(`已重命名为 ${newName}`);
  }

  function wrapSelection() {
    if (!view) return;
    const sel = view.state.selection.main;
    if (sel.empty) return;
    const name = nextModuleName(modules().map((m) => m.name));
    view.dispatch({ changes: wrapSelectionEdits(sel.from, sel.to, name) });
    flash(`已创建模块 ${name}`);
    view.focus();
  }

  function newModule() {
    if (!view) return;
    const text = view.state.doc.toString();
    const name = nextModuleName(parseDoc(text).modules.map((m) => m.name));
    view.dispatch({ changes: [appendModuleEdit(text, name, "")] });
    flash(`已新建模块 ${name}`);
    view.focus();
  }

  function injectEntry(e: LibraryEntry) {
    if (!view) return;
    const text = view.state.doc.toString();
    view.dispatch({ changes: [appendModuleEdit(text, e.name, e.body)] });
    flash(`已注入 ${e.label}`);
    view.focus();
  }

  // 只读随当前目标形态切换：链接一律只读，普通文件恢复可编辑。
  createEffect(() => {
    if (view) setReadOnly(view, isReadOnly());
  });

  onMount(async () => {
    try {
      view = createEditor(editorHost, {
        onDocChanged: syncFromEditor,
        onSelectionChange: (empty) => setHasSelection(!empty),
        onSave: () => void save(),
      });
      // 三件事互不依赖，并行发出：串行 await 会让每个 IPC 往返依次计入首屏时间。
      // 事件监听先于首次载入生效；聚焦回调自己会刷新目标表，不会读到半成品。
      const [, fileChanged, focus] = await Promise.all([
        refreshTargets(),
        listen<{ path: string }>("pizzic:file-changed", (e) => void onExternal(e.payload.path)),
        listen("tauri://focus", async () => {
          await refreshTargets();
          await reconcileShape();
        }),
      ]);
      unlisteners.push(fileChanged, focus);
      const first = targets().find((t) => t.id === "shared") ?? targets()[0];
      if (first) await doLoad(first);

      const mig = pendingMigration;
      pendingMigration = null;
      if (mig) {
        setConfirm({
          title: "旧共享指令已迁移",
          body:
            `已将 ${shortPath(mig.legacyPath, homeDir())} 复制到 ${shortPath(mig.sharedPath, homeDir())}\n` +
            "为防止意外冲突，建议删除旧文件。",
          confirmText: "删除旧文件",
          cancelText: "保留旧文件",
          danger: true,
          onConfirm: () => void removeLegacy(),
        });
      }
    } catch (e) {
      flash(String(e), "warn");
    } finally {
      // 首屏数据就位后再撤启动壳；异常时同样要撤，否则错误会被壳永久盖住。
      // 与上面的渲染发生在同一帧，用户看到的第一帧就是应用本身。
      document.getElementById("boot")?.remove();
    }
  });

  async function removeLegacy() {
    try {
      await api.deleteLegacyShared();
      flash("已将旧共享指令文件移入回收站");
    } catch (e) {
      flash(String(e), "warn");
    }
  }

  onCleanup(() => {
    unlisteners.forEach((u) => u());
    view?.destroy();
    view = null;
  });

  return (
    <div class="relative flex h-full flex-col overflow-hidden">
      {/* 氛围光斑与噪点（固定层，不参与滚动） */}
      <div class="pointer-events-none fixed -left-44 -top-48 size-[580px] rounded-full bg-[#7C5CFF] opacity-[0.10] blur-[130px]" />
      <div class="pointer-events-none fixed -bottom-56 -right-40 size-[540px] rounded-full bg-[#2DD4BF] opacity-[0.07] blur-[130px]" />
      <div class="noise pointer-events-none fixed inset-0 z-[1]" />

      <TitleBar />

      <div class="relative z-10 grid min-h-0 flex-1 grid-cols-[250px_minmax(0,1fr)_292px] gap-3 px-3 pb-3">
        <Sidebar
          targets={targets()}
          currentId={currentId()}
          homeDir={homeDir()}
          onSelect={(id) => void selectTarget(id)}
          onDelete={(id) => {
            const t = targets().find((x) => x.id === id);
            if (t) requestDelete(t);
          }}
          onLink={(id) => {
            const t = targets().find((x) => x.id === id);
            if (t) requestLink(t);
          }}
        />

        <section class="flex min-h-0 min-w-0 flex-col gap-2.5">
          <div class="editor-shell flex min-h-0 flex-1 flex-col">
            <div class="editor-core flex min-h-0 flex-1 flex-col">
              <div class="flex shrink-0 items-center gap-2.5 border-b border-white/[0.05] px-4 py-2.5">
                <i
                  class={`ph-light text-[15px] ${currentIsShared() ? "ph-stack text-accent-2" : "ph-robot text-[#77809A]"}`}
                />
                <span class="text-[13px] font-medium text-[#DDE0EB]">
                  {current()?.label ?? "选择一个文件"}
                </span>
                <Show when={current()}>
                  <span
                    class="hidden max-w-[40%] min-w-0 truncate font-mono text-[10.5px] text-[#59617A] md:block"
                    title={current()!.path}
                  >
                    {shortPath(current()!.path, homeDir())}
                  </span>
                  <Show when={current()!.isLink}>
                    <i
                      class={`ph-light shrink-0 text-[13px] ${
                        current()!.linkTargetExists && current()!.linkTargetIsShared
                          ? "ph-link text-mint/90"
                          : "ph-link-break text-[#FCD34D]"
                      }`}
                      title="符号链接"
                    />
                    <span
                      class={`hidden max-w-[32%] min-w-0 truncate font-mono text-[10.5px] md:block ${
                        current()!.linkTargetExists && current()!.linkTargetIsShared
                          ? "text-mint/80"
                          : "text-[#D6B36A]"
                      }`}
                      title={current()!.linkTarget ?? "未知目标"}
                    >
                      {shortPath(current()!.linkTarget ?? "", homeDir())}
                    </span>
                    <span
                      class="shrink-0 cursor-help rounded-full bg-[#A78BFA]/12 px-2 py-0.5 text-[9.5px] font-medium tracking-wide text-[#C4B5FD] ring-1 ring-[#A78BFA]/25"
                      title={readonlyHint()}
                    >
                      只读
                    </span>
                  </Show>
                </Show>
                <span class="flex-1" />
                <Show when={current()?.exists}>
                  <button
                    type="button"
                    title="从磁盘重新加载"
                    onClick={reloadFromDisk}
                    class="grid size-8 place-items-center rounded-full text-[#77809A] transition-all duration-500 ease-fluid hover:bg-white/[0.07] hover:text-[#C9CEDA] active:scale-90"
                  >
                    <i class="ph-light ph-arrows-clockwise text-[14px]" />
                  </button>
                  <Show when={!current()!.isLink}>
                    <button
                      type="button"
                      onClick={() => void save()}
                      disabled={!dirty()}
                      class={`flex h-8 items-center gap-2 rounded-full pl-4 pr-1.5 text-[12px] font-medium transition-all duration-500 ease-fluid active:scale-[0.97] disabled:cursor-default disabled:opacity-40 disabled:active:scale-100 ${
                        dirty()
                          ? "bg-gradient-to-r from-[#8B5CF6]/85 to-[#6EE7D8]/80 text-ink-950 shadow-[0_4px_18px_-6px_rgba(139,92,246,0.7)] hover:brightness-110"
                          : "bg-white/[0.05] text-[#8A91A6] ring-1 ring-white/[0.08]"
                      }`}
                    >
                      保存
                      <span
                        class={`grid h-[22px] place-items-center rounded-full px-2 font-mono text-[9.5px] tracking-wide ${
                          dirty() ? "bg-ink-950/25 text-ink-950/80" : "bg-white/[0.06] text-[#77809A]"
                        }`}
                      >
                        CTRL S
                      </span>
                    </button>
                  </Show>
                </Show>
              </div>

              {/* 共享指令自身是链接：只读且只能删除链接，改指向对自己没有意义 */}
              <Show when={current()?.isLink && current()!.kind === "shared"}>
                <div class="animate-rise mx-3 mt-2 flex shrink-0 items-center gap-3 rounded-2xl bg-[#FCD34D]/[0.06] px-4 py-2 ring-1 ring-[#FCD34D]/[0.16]">
                  <i class="ph-light ph-warning text-[15px] text-[#FCD34D]" />
                  <span class="flex-1 text-[12px] text-[#DCCf9A]">
                    共享指令文件本身是符号链接（指向 {current()!.linkTarget
                      ? shortPath(current()!.linkTarget!, homeDir())
                      : "未知目标"}
                    ），编辑器只读。删除该链接后可在此重建普通文件。
                  </span>
                  <button
                    type="button"
                    onClick={() => requestDelete(current()!)}
                    class="h-7 rounded-full px-3 text-[11.5px] text-[#8A91A6] transition-all duration-500 ease-fluid hover:bg-white/[0.07] hover:text-[#D6DAE5]"
                  >
                    删除链接
                  </button>
                </div>
              </Show>

              {/* Agent 链接形态提示：只读原因与就地修复出口 */}
              <Show
                when={
                  current()?.isLink &&
                  current()!.kind === "agent" &&
                  (linkIsForeign() || linkIsBroken())
                }
              >
                <div class="animate-rise mx-3 mt-2 flex shrink-0 items-center gap-3 rounded-2xl bg-[#FCD34D]/[0.06] px-4 py-2 ring-1 ring-[#FCD34D]/[0.16]">
                  <i class="ph-light ph-warning text-[15px] text-[#FCD34D]" />
                  <span class="flex-1 text-[12px] text-[#DCCf9A]">
                    <Show
                      when={linkIsForeign()}
                      fallback={<>符号链接指向的共享指令文件不存在，编辑器已只读。</>}
                    >
                      符号链接目标不是 Pizzic 的共享指令文件
                      {current()!.linkTargetExists
                        ? "，编辑器已只读，且不显示目标内容（避免读取任意文件）。"
                        : "，且目标不存在。"}
                    </Show>
                  </span>
                  <Show
                    when={linkIsForeign()}
                    fallback={
                      <Show when={!current()!.linkTargetExists}>
                        <button
                          type="button"
                          onClick={() => void createSharedFile()}
                          class="h-7 rounded-full bg-[#FCD34D]/15 px-3 text-[11.5px] font-medium text-[#FCD34D] ring-1 ring-[#FCD34D]/25 transition-all duration-500 ease-fluid hover:bg-[#FCD34D]/25"
                        >
                          创建共享指令文件
                        </button>
                      </Show>
                    }
                  >
                    <button
                      type="button"
                      onClick={() => requestLink(current()!)}
                      class="h-7 rounded-full bg-[#FCD34D]/15 px-3 text-[11.5px] font-medium text-[#FCD34D] ring-1 ring-[#FCD34D]/25 transition-all duration-500 ease-fluid hover:bg-[#FCD34D]/25"
                    >
                      改指向共享指令
                    </button>
                  </Show>
                  <button
                    type="button"
                    onClick={() => requestDelete(current()!)}
                    class="h-7 rounded-full px-3 text-[11.5px] text-[#8A91A6] transition-all duration-500 ease-fluid hover:bg-white/[0.07] hover:text-[#D6DAE5]"
                  >
                    删除链接
                  </button>
                </div>
              </Show>

              <Show when={externalMode() === "conflict"}>
                <div class="animate-rise mx-3 mt-2 flex shrink-0 items-center gap-3 rounded-2xl bg-[#FCD34D]/[0.06] px-4 py-2 ring-1 ring-[#FCD34D]/[0.16]">
                  <i class="ph-light ph-warning text-[15px] text-[#FCD34D]" />
                  <span class="flex-1 text-[12px] text-[#DCCf9A]">
                    文件在磁盘上已被外部修改（可能来自 Agent 本身），本地还有未保存内容。
                  </span>
                  <button
                    type="button"
                    onClick={reloadFromDisk}
                    class="h-7 rounded-full px-3 text-[11.5px] text-[#8A91A6] transition-all duration-500 ease-fluid hover:bg-white/[0.07] hover:text-[#D6DAE5]"
                  >
                    放弃本地修改
                  </button>
                  <button
                    type="button"
                    onClick={() => void save()}
                    class="h-7 rounded-full bg-[#FCD34D]/15 px-3 text-[11.5px] font-medium text-[#FCD34D] ring-1 ring-[#FCD34D]/25 transition-all duration-500 ease-fluid hover:bg-[#FCD34D]/25"
                  >
                    覆盖磁盘
                  </button>
                </div>
              </Show>

              {/* 文件在外部被换成符号链接：只给放弃入口，绝不提供写穿链接的保存 */}
              <Show when={externalMode() === "link"}>
                <div class="animate-rise mx-3 mt-2 flex shrink-0 items-center gap-3 rounded-2xl bg-[#E5484D]/[0.07] px-4 py-2 ring-1 ring-[#E5484D]/[0.18]">
                  <i class="ph-light ph-warning text-[15px] text-[#FB7185]" />
                  <span class="flex-1 text-[12px] text-[#E4A3A6]">
                    文件已变为符号链接，本地未保存的修改无法写入磁盘。
                  </span>
                  <button
                    type="button"
                    onClick={reloadFromDisk}
                    class="h-7 rounded-full bg-[#E5484D]/15 px-3 text-[11.5px] font-medium text-[#FB7185] ring-1 ring-[#E5484D]/25 transition-all duration-500 ease-fluid hover:bg-[#E5484D]/25"
                  >
                    放弃本地修改并重新加载
                  </button>
                </div>
              </Show>

              <div class="relative min-h-0 flex-1">
                <div ref={editorHost} class="absolute inset-0" />
                <Show when={current() && !current()!.exists}>
                  <div class="absolute inset-0 grid place-items-center bg-ink-900/40">
                    <div class="animate-rise flex max-w-sm flex-col items-center gap-4 text-center">
                      <span class="grid size-16 place-items-center rounded-[1.4rem] bg-white/[0.04] ring-1 ring-white/[0.08]">
                        <i class="ph-light ph-file-plus text-[26px] text-[#77809A]" />
                      </span>
                      <div>
                        <p class="text-[14px] font-medium text-[#C9CEDA]">
                          {current()!.label} 的指令文件尚未创建
                        </p>
                        <p class="mt-1.5 break-all font-mono text-[11px] leading-relaxed text-[#59617A]">
                          {shortPath(current()!.path, homeDir())}
                        </p>
                      </div>
                      <div class="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void createFile()}
                          class="flex h-10 items-center gap-2 rounded-full bg-white/[0.05] px-5 text-[13px] text-[#B4BACC] ring-1 ring-white/[0.09] transition-all duration-500 ease-fluid hover:bg-white/[0.09] hover:text-[#E7EAF2] active:scale-[0.97]"
                        >
                          <i class="ph-light ph-plus text-[15px]" />
                          创建文件
                        </button>
                        <Show when={current()!.kind === "agent"}>
                          <button
                            type="button"
                            onClick={() => requestLink(current()!)}
                            title="创建指向共享指令文件的符号链接（内容与「共享指令」始终保持一致）"
                            class="flex h-10 items-center gap-2 rounded-full bg-gradient-to-r from-[#8B5CF6] to-[#6EE7D8] px-6 text-[13px] font-medium text-ink-950 shadow-[0_10px_30px_-10px_rgba(139,92,246,0.8)] transition-all duration-500 ease-fluid hover:brightness-110 active:scale-[0.97]"
                          >
                            <i class="ph-light ph-link text-[15px]" />
                            创建符号链接
                          </button>
                        </Show>
                      </div>
                    </div>
                  </div>
                </Show>
              </div>
            </div>
          </div>

          <StatusBar
            encoding={encoding()}
            lineEnding={lineEnding()}
            dirty={dirty()}
            lines={stats().lines}
            chars={stats().chars}
            flash={status()}
          />
        </section>

        <ModulePanel
          modules={panelModules()}
          archived={archived()}
          archivedList={archivedList()}
          hasSelection={hasSelection()}
          currentIsShared={currentIsShared()}
          readonly={isReadOnly()}
          lib={sharedLib()}
          onToggle={(name) => void toggleModule(name)}
          onDelete={(name) => void removeModule(name)}
          onDeleteArchived={(name) => void deleteArchived(name)}
          onRename={(oldName, newName) => void renameModule(oldName, newName)}
          onWrapSelection={wrapSelection}
          onNewModule={newModule}
          onInject={injectEntry}
          onReloadLib={() => void loadSharedLib()}
        />
      </div>

      <ConfirmModal spec={confirm()} onCancel={() => setConfirm(null)} />
    </div>
  );
}
