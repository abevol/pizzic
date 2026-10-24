import { For, Show, createSignal } from "solid-js";
import type { ArchivedEntry } from "../lib/api";
import { NAME_RE } from "../lib/document";

export interface PanelModule {
  name: string;
  label: string;
  hue: number;
  enabled: boolean;
  chars: number;
}

/** 停用区条目（存档驱动，ADR-004）。 */
export interface ArchivedModule {
  name: string;
  hue: number;
  label: string;
  chars: number;
}

export interface LibraryEntry {
  name: string;
  label: string;
  body: string;
  hasBody: boolean;
  /** 条目来自共享文件的停用存档（而非文档中的启用模块） */
  archived: boolean;
}

export function Toggle(props: { on: boolean; onChange(): void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      disabled={props.disabled}
      onClick={() => props.onChange()}
      class={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-all duration-500 ease-fluid active:scale-95 disabled:cursor-default disabled:opacity-35 disabled:active:scale-100 ${
        props.on
          ? "bg-gradient-to-r from-[#8B5CF6]/75 to-[#2DD4BF]/55 ring-1 ring-white/25 shadow-[0_0_12px_-2px_rgba(139,92,246,0.55)]"
          : "bg-white/[0.07] ring-1 ring-white/[0.09]"
      }`}
    >
      <span
        class={`absolute top-1/2 size-[16px] -translate-y-1/2 rounded-full bg-[#E8EAF2] shadow-[0_1px_3px_rgba(0,0,0,0.5)] transition-all duration-500 ease-fluid ${
          props.on ? "left-[19px]" : "left-[3px]"
        }`}
      />
    </button>
  );
}

function IconBtn(props: { icon: string; title: string; danger?: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      title={props.title}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
      class={`grid size-6 place-items-center rounded-lg text-[#6E7690] opacity-0 transition-all duration-300 ease-fluid group-hover:opacity-100 hover:bg-white/[0.08] hover:text-[#C9CEDA] active:scale-90 ${
        props.danger ? "hover:!text-[#FB7185]" : ""
      }`}
    >
      <i class={`ph-light ${props.icon} text-[13px]`} />
    </button>
  );
}

export function ModulePanel(props: {
  modules: PanelModule[];
  archived: Record<string, ArchivedEntry>;
  archivedList: ArchivedModule[];
  hasSelection: boolean;
  currentIsShared: boolean;
  /** 符号链接只读预览：模块可见，所有写操作禁用，存档与共享库不展示。 */
  readonly: boolean;
  lib: LibraryEntry[] | null;
  onToggle(name: string): void;
  onDelete(name: string): void;
  onDeleteArchived(name: string): void;
  onRename(oldName: string, newName: string): void;
  onWrapSelection(): void;
  onNewModule(): void;
  onInject(entry: LibraryEntry): void;
  onReloadLib(): void;
}) {
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [draft, setDraft] = createSignal("");
  const [confirming, setConfirming] = createSignal<string | null>(null);
  const [libOpen, setLibOpen] = createSignal(false);
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;

  const beginRename = (name: string) => {
    setRenaming(name);
    setDraft(name);
  };

  const commitRename = () => {
    const oldName = renaming();
    if (!oldName) return;
    const next = draft().trim();
    setRenaming(null);
    if (next === oldName) return;
    if (!NAME_RE.test(next) || props.modules.some((m) => m.name === next)) return;
    props.onRename(oldName, next);
  };

  const askDelete = (name: string) => {
    setConfirming(name);
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => setConfirming(null), 4000);
  };

  const toolPill = (p: {
    icon: string;
    label: string;
    disabled?: boolean;
    onClick(): void;
  }) => (
    <button
      type="button"
      disabled={p.disabled}
      onClick={p.onClick}
      class="flex h-8 items-center gap-1.5 rounded-full bg-white/[0.05] px-3.5 text-[12px] text-[#B4BACC] ring-1 ring-white/[0.08] transition-all duration-500 ease-fluid hover:bg-white/[0.09] hover:text-[#E7EAF2] active:scale-[0.96] disabled:cursor-default disabled:opacity-35 disabled:hover:bg-white/[0.05] disabled:active:scale-100"
    >
      <i class={`ph-light ${p.icon} text-[13px]`} />
      {p.label}
    </button>
  );

  return (
    <aside class="shell flex min-h-0 flex-col">
      <div class="flex shrink-0 items-center gap-2 px-4 pb-2 pt-3.5">
        <span class="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#59617A]">
          模块
        </span>
        <span class="rounded-full bg-white/[0.06] px-2 py-0.5 font-mono text-[10px] text-[#8F97AC]">
          {props.modules.filter((m) => m.enabled).length}/
          {props.modules.length + props.archivedList.length}
        </span>
        <span class="flex-1" />
        {toolPill({
          icon: "ph-textbox",
          label: "选区成模块",
          disabled: props.readonly || !props.hasSelection,
          onClick: props.onWrapSelection,
        })}
        {toolPill({
          icon: "ph-plus",
          label: "新建",
          disabled: props.readonly,
          onClick: props.onNewModule,
        })}
      </div>

      <Show when={props.readonly}>
        <div class="flex shrink-0 items-center gap-1.5 px-4 pb-2 text-[10.5px] text-[#59617A]">
          <i class="ph-light ph-eye text-[11px]" />
          只读预览 · 当前文件是符号链接
        </div>
      </Show>

      <div class="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">
        <Show
          when={props.modules.length > 0}
          fallback={
            <div class="mt-14 flex flex-col items-center gap-3 px-6 text-center">
              <i class="ph-light ph-puzzle-piece text-[30px] text-[#3E4560]" />
              <p class="text-[12.5px] leading-relaxed text-[#59617A]">
                <Show
                  when={!props.readonly}
                  fallback={<>该视图没有可显示的模块。</>}
                >
                  尚无模块。
                  <br />
                  选中正文「选区成模块」，或从下方共享库注入。
                </Show>
              </p>
            </div>
          }
        >
          <div class="flex flex-col gap-1">
            <For each={props.modules}>
              {(m, i) => {
                const isRenaming = () => renaming() === m.name;
                const isConfirming = () => confirming() === m.name;
                return (
                  <div
                    class="animate-rise"
                    style={{ "animation-delay": `${Math.min(i() * 45, 400)}ms` }}
                  >
                    <div
                      class={`group rounded-2xl px-3 py-2.5 transition-all duration-500 ease-fluid ${
                        m.enabled
                          ? "hover:bg-white/[0.04]"
                          : "opacity-55 hover:opacity-80"
                      }`}
                    >
                      <div class="flex items-center gap-2.5">
                        <span
                          class="size-2 shrink-0 rounded-full transition-all duration-500"
                          style={{
                            background: m.enabled ? HUE_DOT[m.hue] : "transparent",
                            "box-shadow": m.enabled ? `0 0 8px ${HUE_DOT[m.hue]}` : "none",
                            border: m.enabled ? "none" : `1.5px dashed ${HUE_DOT[m.hue]}55`,
                          }}
                        />
                        <span class="min-w-0 flex-1">
                          <Show
                            when={!isRenaming()}
                            fallback={
                              <input
                                autofocus
                                value={draft()}
                                onInput={(e) => setDraft(e.currentTarget.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") commitRename();
                                  if (e.key === "Escape") setRenaming(null);
                                }}
                                onBlur={commitRename}
                                class="w-full rounded-lg bg-white/[0.07] px-2 py-0.5 font-mono text-[12px] text-[#E7EAF2] outline-none ring-1 ring-accent/40"
                              />
                            }
                          >
                            <span
                              class={`block truncate text-[13px] leading-5 ${
                                m.enabled ? "text-[#DDE0EB]" : "text-[#8A91A6]"
                              }`}
                            >
                              {m.label}
                            </span>
                            <span class="block truncate font-mono text-[10.5px] leading-4 text-[#59617A]">
                              {m.name} · {m.chars} 字
                              <Show when={!m.enabled && props.archived[m.name] === undefined}>
                                <span class="text-[#C08A5B]"> · 无存档</span>
                              </Show>
                            </span>
                          </Show>
                        </span>
                        <Show
                          when={!isConfirming()}
                          fallback={
                            <div class="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => {
                                  setConfirming(null);
                                  props.onDelete(m.name);
                                }}
                                class="h-6 rounded-full bg-[#E5484D]/15 px-2.5 text-[11px] text-[#FB7185] ring-1 ring-[#E5484D]/30 transition-all duration-300 hover:bg-[#E5484D]/25"
                              >
                                删除
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirming(null)}
                                class="h-6 rounded-full px-2 text-[11px] text-[#6E7690] hover:text-[#C9CEDA]"
                              >
                                取消
                              </button>
                            </div>
                          }
                        >
                          <Show when={!isRenaming()}>
                            <Show when={!props.readonly}>
                              <span class="flex items-center">
                                <IconBtn
                                  icon="ph-pencil-simple"
                                  title="重命名"
                                  onClick={() => beginRename(m.name)}
                                />
                                <IconBtn
                                  icon="ph-trash"
                                  title="删除模块"
                                  danger
                                  onClick={() => askDelete(m.name)}
                                />
                              </span>
                            </Show>
                          </Show>
                          <Toggle
                            on={m.enabled}
                            onChange={() => props.onToggle(m.name)}
                            disabled={props.readonly}
                          />
                        </Show>
                      </div>
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>

        <Show when={!props.readonly && props.archivedList.length > 0}>
          <div class="mt-4 mb-1 flex items-center gap-2 px-3">
            <span class="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#59617A]">
              已停用
            </span>
            <span class="rounded-full bg-white/[0.05] px-1.5 py-0.5 font-mono text-[9.5px] text-[#59617A]">
              {props.archivedList.length}
            </span>
            <span class="h-px flex-1 bg-gradient-to-r from-white/[0.09] to-transparent" />
          </div>
          <div class="flex flex-col gap-1 pb-1">
            <For each={props.archivedList}>
              {(a, i) => {
                const isConfirming = () => confirming() === a.name;
                return (
                  <div
                    class="animate-rise"
                    style={{ "animation-delay": `${Math.min(i() * 45, 300)}ms` }}
                  >
                    <div class="group rounded-2xl px-3 py-2.5 opacity-60 transition-all duration-500 ease-fluid hover:opacity-85">
                      <div class="flex items-center gap-2.5">
                        <span
                          class="size-2 shrink-0 rounded-full border border-dashed transition-all duration-500"
                          style={{
                            "border-color": `${HUE_DOT[a.hue]}66`,
                          }}
                        />
                        <span class="min-w-0 flex-1">
                          <span class="block truncate text-[13px] leading-5 text-[#8A91A6]">
                            {a.label}
                          </span>
                          <span class="block truncate font-mono text-[10.5px] leading-4 text-[#59617A]">
                            {a.name} · {a.chars} 字（存档）
                          </span>
                        </span>
                        <Show
                          when={!isConfirming()}
                          fallback={
                            <div class="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => {
                                  setConfirming(null);
                                  props.onDeleteArchived(a.name);
                                }}
                                class="h-6 rounded-full bg-[#E5484D]/15 px-2.5 text-[11px] text-[#FB7185] ring-1 ring-[#E5484D]/30 transition-all duration-300 hover:bg-[#E5484D]/25"
                              >
                                删除
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirming(null)}
                                class="h-6 rounded-full px-2 text-[11px] text-[#6E7690] hover:text-[#C9CEDA]"
                              >
                                取消
                              </button>
                            </div>
                          }
                        >
                          <span class="flex items-center">
                            <IconBtn
                              icon="ph-trash"
                              title="删除停用存档（正文将不可恢复）"
                              danger
                              onClick={() => askDelete(a.name)}
                            />
                          </span>
                          <Toggle
                            on={false}
                            onChange={() => props.onToggle(a.name)}
                            disabled={props.readonly}
                          />
                        </Show>
                      </div>
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </div>

      <Show when={!props.readonly}>
        <div class="shrink-0 border-t border-white/[0.05] px-2.5 py-2">
        <button
          type="button"
          class="group flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-all duration-300 ease-fluid hover:bg-white/[0.04]"
          onClick={() => setLibOpen(!libOpen())}
        >
          <i
            class={`ph-light ph-caret-right text-[11px] text-[#6E7690] transition-transform duration-500 ease-fluid ${
              libOpen() ? "rotate-90" : ""
            }`}
          />
          <span class="flex-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#59617A]">
            共享模块库
          </span>
          <Show when={!props.currentIsShared}>
            <IconBtn icon="ph-arrows-clockwise" title="刷新共享库" onClick={props.onReloadLib} />
          </Show>
        </button>

        <Show when={libOpen()}>
          <Show
            when={!props.currentIsShared}
            fallback={
              <p class="px-3 py-2 text-[11.5px] leading-relaxed text-[#59617A]">
                当前正在编辑共享文件本身——其他 Agent 文件可直接从这里注入它的模块。
              </p>
            }
          >
            <Show
              when={props.lib !== null}
              fallback={
                <p class="px-3 py-2.5 text-[11.5px] text-[#59617A]">
                  <i class="ph-light ph-circle-notch animate-spin" /> 正在读取共享文件…
                </p>
              }
            >
              <Show
                when={(props.lib ?? []).length > 0}
                fallback={
                  <p class="px-3 py-2.5 text-[11.5px] leading-relaxed text-[#59617A]">
                    共享文件中还没有模块。
                  </p>
                }
              >
                <div class="flex max-h-52 flex-col gap-0.5 overflow-y-auto pb-1">
                  <For each={props.lib ?? []}>
                    {(e) => {
                      const exists = () => props.modules.some((m) => m.name === e.name);
                      return (
                        <div class="group flex items-center gap-2 rounded-xl px-2.5 py-1.5 transition-colors duration-300 hover:bg-white/[0.04]">
                          <span class="min-w-0 flex-1">
                            <span class="block truncate text-[12px] text-[#B4BACC]">
                              {e.label}
                            </span>
                            <span class="block truncate font-mono text-[10px] text-[#59617A]">
                              {e.name}
                              <Show when={e.archived}>
                                <span class="text-[#4E5670]"> · 存档</span>
                              </Show>
                            </span>
                          </span>
                          <Show
                            when={!exists()}
                            fallback={
                              <span class="pr-1 text-[10.5px] text-[#4E5670]">已存在</span>
                            }
                          >
                            <button
                              type="button"
                              disabled={!e.hasBody}
                              title={e.hasBody ? "注入到当前文件末尾" : "该模块没有可用正文"}
                              onClick={() => props.onInject(e)}
                              class="grid size-6 place-items-center rounded-lg text-[#6E7690] transition-all duration-300 ease-fluid hover:bg-white/[0.09] hover:text-accent-2 active:scale-90 disabled:opacity-30 disabled:hover:bg-transparent"
                            >
                              <i class="ph-light ph-download-simple text-[13px]" />
                            </button>
                          </Show>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </Show>
          </Show>
        </Show>
        </div>
      </Show>
    </aside>
  );
}

const HUE_DOT = ["#A78BFA", "#5EEAD4", "#FCD34D", "#FB7185", "#7DD3FC", "#BEF264"];
