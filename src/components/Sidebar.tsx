import { For, Show, createMemo, createSignal } from "solid-js";
import type { TargetInfo } from "../lib/api";

/** Phosphor 图标映射；未列出的 Agent 统一用 ph-robot。 */
const AGENT_ICONS: Record<string, string> = {
  claude: "ph-sparkle",
  codex: "ph-terminal-window",
  gemini: "ph-star-four",
  agy: "ph-rocket",
  opencode: "ph-brackets",
  deveco: "ph-cube",
  dsh: "ph-pulse",
  goose: "ph-bird",
  copilot: "ph-paper-plane-tilt",
  crush: "ph-flame",
  zcode: "ph-lightning",
  kimi: "ph-moon-stars",
  alma: "ph-identification-card",
  grok: "ph-x-logo",
  droid: "ph-android-logo",
  qoder: "ph-code",
  "qoder-cn": "ph-code",
  codebuddy: "ph-users-three",
  fx: "ph-magic-wand",
  "prime-agent": "ph-crown-simple",
  stepcode: "ph-stairs",
  atomcode: "ph-atom",
  qwen: "ph-cloud",
  reasonix: "ph-waveform",
};

function iconFor(t: TargetInfo): string {
  return t.kind === "shared" ? "ph-stack" : (AGENT_ICONS[t.id] ?? "ph-robot");
}

/** 显示时把主目录折叠成 ~，既短又符合终端习惯。 */
export function shortPath(path: string, home: string): string {
  const norm = path.replace(/\//g, "\\");
  const homeNorm = home.replace(/\//g, "\\");
  if (homeNorm && norm.toLowerCase().startsWith(homeNorm.toLowerCase())) {
    return "~" + norm.slice(homeNorm.length);
  }
  return norm;
}

/** 符号链接标记：有效指向共享文件用薄荷色，其余（其他目标/悬空）用琥珀色。 */
export function linkBadge(t: TargetInfo, home: string) {
  const healthy = t.isLink && t.linkTargetIsShared && t.linkTargetExists;
  const icon = t.linkTargetExists ? "ph-link" : "ph-link-break";
  return (
    <i
      title={`符号链接 → ${t.linkTarget ? shortPath(t.linkTarget, home) : "未知目标"}`}
      class={`ph-light ${icon} shrink-0 text-[11px] ${
        healthy ? "text-mint/90" : "text-[#FCD34D]"
      }`}
    />
  );
}

function RowAction(props: {
  icon: string;
  title: string;
  danger?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.title}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
      class={`grid size-6 place-items-center rounded-lg bg-[#0C0E13]/85 text-[#8A91A6] ring-1 ring-white/[0.08] backdrop-blur-sm transition-all duration-300 ease-fluid hover:bg-[#171A22] hover:text-[#E7EAF2] active:scale-90 ${
        props.danger ? "hover:!text-[#FB7185]" : ""
      }`}
    >
      <i class={`ph-light ${props.icon} text-[13px]`} />
    </button>
  );
}

export function Sidebar(props: {
  targets: TargetInfo[];
  currentId: string | null;
  homeDir: string;
  onSelect(id: string): void;
  onDelete(id: string): void;
  onLink(id: string): void;
}) {
  const [showMissing, setShowMissing] = createSignal(false);
  const shared = createMemo(() => props.targets.filter((t) => t.kind === "shared"));
  const byName = (a: TargetInfo, b: TargetInfo) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  const agents = createMemo(() => props.targets.filter((t) => t.kind === "agent"));
  const existing = createMemo(() => agents().filter((t) => t.exists).sort(byName));
  const missing = createMemo(() => agents().filter((t) => !t.exists).sort(byName));

  /** 转链接/改指向：普通文件可转换，指向别处的链接可改指向；已正确指向者无需动作。 */
  const canLink = (t: TargetInfo) =>
    t.kind === "agent" && t.exists && (!t.isLink || !t.linkTargetIsShared);
  /** 删除：Agent 文件与链接可删；共享目标仅在自身是链接时给出口（保护共享正文）。 */
  const canDelete = (t: TargetInfo) =>
    t.exists && (t.kind === "agent" || t.isLink);

  const item = (t: TargetInfo) => {
    const selected = () => props.currentId === t.id;
    const hasActions = () => canLink(t) || canDelete(t);
    return (
      <div
        class={`group relative rounded-2xl transition-all duration-500 ease-fluid ${
          selected()
            ? "bg-white/[0.07] ring-1 ring-white/[0.09] shadow-[inset_0_1px_1px_rgba(255,255,255,0.06)]"
            : "hover:bg-white/[0.035]"
        }`}
      >
        <button
          type="button"
          onClick={() => props.onSelect(t.id)}
          class="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left active:scale-[0.985]"
        >
          <span
            class={`grid size-8 shrink-0 place-items-center rounded-xl transition-all duration-500 ease-fluid ${
              selected()
                ? "bg-gradient-to-br from-[#A78BFA]/20 to-[#5EEAD4]/10 ring-1 ring-white/[0.12]"
                : "bg-white/[0.04] ring-1 ring-white/[0.06] group-hover:bg-white/[0.07]"
            }`}
          >
            <i
              class={`ph-light ${iconFor(t)} text-[15px] transition-colors duration-500 ${
                selected() ? "text-accent-2" : "text-[#77809A] group-hover:text-[#A7AEBF]"
              }`}
            />
          </span>
          <span class={`min-w-0 flex-1 ${hasActions() ? "pr-14" : ""}`}>
            <span class="flex items-center gap-1.5">
              <span
                class={`truncate text-[13px] font-medium transition-colors duration-500 ${
                  selected() ? "text-[#EDEFF7]" : "text-[#B4BACC] group-hover:text-[#D6DAE5]"
                }`}
              >
                {t.label}
              </span>
              <Show when={t.exists}>
                <span
                  title={t.isLink ? "路径已被符号链接占用" : "文件已创建"}
                  class="size-[5px] shrink-0 rounded-full bg-mint/90 shadow-[0_0_6px_rgba(94,234,212,0.5)]"
                />
              </Show>
              <Show when={t.isLink}>{linkBadge(t, props.homeDir)}</Show>
            </span>
            <span class="mt-0.5 block truncate font-mono text-[10.5px] leading-4 text-[#59617A]">
              {shortPath(t.path, props.homeDir)}
            </span>
          </span>
        </button>

        <Show when={hasActions()}>
          <div class="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity duration-300 ease-fluid group-hover:opacity-100 group-focus-within:opacity-100">
            <Show when={canLink(t)}>
              <RowAction
                icon="ph-link"
                title={t.isLink ? "改指向共享指令" : "转换为符号链接"}
                onClick={() => props.onLink(t.id)}
              />
            </Show>
            <Show when={canDelete(t)}>
              <RowAction
                icon="ph-trash"
                danger
                title={t.isLink ? "删除符号链接（仅删除链接本身）" : "移入回收站"}
                onClick={() => props.onDelete(t.id)}
              />
            </Show>
          </div>
        </Show>
      </div>
    );
  };

  return (
    <aside class="shell flex min-h-0 flex-col">
      <div class="flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5 py-3">
        <For each={shared()}>
          {(t) => <div class="animate-fadein">{item(t)}</div>}
        </For>

        <div class="mt-5 mb-2 flex items-center gap-2 px-3">
          <span class="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#59617A]">
            Agent 指令
          </span>
          <span class="h-px flex-1 bg-gradient-to-r from-white/[0.09] to-transparent" />
        </div>

        <Show
          when={existing().length > 0}
          fallback={
            <p class="px-3 py-1.5 text-[11.5px] leading-relaxed text-[#4E5670]">
              尚无 Agent 指令文件——从下方「未创建」中选择并创建。
            </p>
          }
        >
          <div class="flex flex-col gap-1">
            <For each={existing()}>
              {(t, i) => (
                <div class="animate-rise" style={{ "animation-delay": `${80 + i() * 55}ms` }}>
                  {item(t)}
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={missing().length > 0}>
          <button
            type="button"
            class="group mt-3 flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition-all duration-300 ease-fluid hover:bg-white/[0.04]"
            onClick={() => setShowMissing(!showMissing())}
          >
            <i
              class={`ph-light ph-caret-right text-[11px] text-[#6E7690] transition-transform duration-500 ease-fluid ${
                showMissing() ? "rotate-90" : ""
              }`}
            />
            <span class="flex-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-[#59617A]">
              未创建
            </span>
            <span class="rounded-full bg-white/[0.05] px-1.5 py-0.5 font-mono text-[9.5px] text-[#59617A]">
              {missing().length}
            </span>
          </button>
          <Show when={showMissing()}>
            <div class="mt-1 flex flex-col gap-0.5 opacity-75">
              <For each={missing()}>{(t) => item(t)}</For>
            </div>
          </Show>
        </Show>
      </div>
    </aside>
  );
}
