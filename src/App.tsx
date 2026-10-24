import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import type { EditorView } from "@codemirror/view";
import { api, type ArchivedEntry, type FileSnapshot, type TargetInfo } from "./lib/api";
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
import { createEditor, replaceDoc } from "./lib/editor";
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
  const [external, setExternal] = createSignal(false);
  const [status, setStatus] = createSignal<StatusFlash | null>(null);
  const [stats, setStats] = createSignal({ lines: 0, chars: 0 });
  const [sharedLib, setSharedLib] = createSignal<LibraryEntry[] | null>(null);
  const [confirm, setConfirm] = createSignal<ConfirmSpec | null>(null);
  const [lineEnding, setLineEnding] = createSignal<"LF" | "CRLF" | null>(null);
  const [encoding, setEncoding] = createSignal<string | null>(null);

  let editorHost!: HTMLDivElement;
  let view: EditorView | null = null;
  let loadedPath = "";
  let pendingSelect: string | null = null;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  const unlisteners: Array<() => void> = [];

  const current = createMemo(() => targets().find((t) => t.id === currentId()) ?? null);
  const currentIsShared = createMemo(() => current()?.kind === "shared");
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
    } catch (e) {
      flash(String(e), "warn");
    }
  }

  async function loadSharedLib() {
    const shared = targets().find((t) => t.kind === "shared");
    if (!shared || !shared.exists || currentIsShared()) {
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

  async function doLoad(t: TargetInfo) {
    if (!view) return;
    setCurrentId(t.id);
    if (!t.exists) {
      loadedPath = "";
      setDisk(null);
      setDirty(false);
      setExternal(false);
      setModules([]);
      setStats({ lines: 0, chars: 0 });
      setLineEnding(null);
      setEncoding(null);
      replaceDoc(view, "");
      try {
        setArchived(await api.getDisabled(t.path));
      } catch {
        setArchived({});
      }
      void loadSharedLib();
      return;
    }
    try {
      const snap = await api.readFile(t.path);
      loadedPath = t.path;
      setDisk(snap);
      setDirty(false);
      setExternal(false);
      setArchived(await api.getDisabled(t.path));
      applySnapshot(snap);
    } catch (e) {
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

  async function save() {
    const t = current();
    if (!t || !view) return;
    // 编辑器内部是 LF；写盘前按文件实际换行模式还原，保持磁盘文件字节形态。
    const editorText = view.state.doc.toString();
    const text = lineEnding() === "CRLF" ? editorText.replace(/\r?\n/g, "\r\n") : editorText;
    try {
      const snap = await api.writeFile(t.path, text);
      loadedPath = t.path;
      setDisk(snap);
      setDirty(false);
      setExternal(false);
      flash(`已保存 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`);
      void refreshTargets();
    } catch (e) {
      flash(String(e), "warn");
    }
  }

  async function createFile() {
    const t = current();
    if (!t || !view) return;
    try {
      const snap = await api.writeFile(t.path, starterContent(t));
      await refreshTargets();
      loadedPath = t.path;
      setDisk(snap);
      setDirty(false);
      applySnapshot(snap);
      flash("文件已创建");
      void loadSharedLib();
    } catch (e) {
      flash(String(e), "warn");
    }
  }

  function reloadFromDisk() {
    const t = current();
    if (t) void doLoad(t);
  }

  async function onExternal(changed: string) {
    void refreshTargets();
    const t = current();
    if (t && samePath(changed, t.path)) {
      if (dirty()) {
        setExternal(true);
        return;
      }
      if (t.exists && view) {
        try {
          const snap = await api.readFile(t.path);
          // 自写回声兜底：磁盘内容与编辑器语义一致（EOL 归一化后相同）则不打扰。
          if (normalizeEOL(view.state.doc.toString()) === normalizeEOL(snap.text)) {
            setDisk(snap);
            return;
          }
          setDisk(snap);
          applySnapshot(snap);
          flash("检测到外部修改，已重新加载");
        } catch {
          /* 文件可能刚被删除，等待下一次刷新 */
        }
      }
    }
    const shared = targets().find((x) => x.kind === "shared");
    if (shared && samePath(changed, shared.path)) void loadSharedLib();
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

  onMount(async () => {
    view = createEditor(editorHost, {
      onDocChanged: syncFromEditor,
      onSelectionChange: (empty) => setHasSelection(!empty),
      onSave: () => void save(),
    });
    await refreshTargets();
    unlisteners.push(
      await listen<{ path: string }>("pizzic:file-changed", (e) => void onExternal(e.payload.path)),
      await listen("tauri://focus", () => void refreshTargets()),
    );
    const first = targets().find((t) => t.id === "shared") ?? targets()[0];
    if (first) await doLoad(first);
  });

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
                    class="hidden min-w-0 truncate font-mono text-[10.5px] text-[#59617A] md:block"
                    title={current()!.path}
                  >
                    {shortPath(current()!.path, homeDir())}
                  </span>
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
              </div>

              <Show when={external()}>
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
                      <button
                        type="button"
                        onClick={() => void createFile()}
                        class="flex h-10 items-center gap-2 rounded-full bg-gradient-to-r from-[#8B5CF6] to-[#6EE7D8] px-6 text-[13px] font-medium text-ink-950 shadow-[0_10px_30px_-10px_rgba(139,92,246,0.8)] transition-all duration-500 ease-fluid hover:brightness-110 active:scale-[0.97]"
                      >
                        <i class="ph-light ph-plus text-[15px]" />
                        创建文件
                      </button>
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
