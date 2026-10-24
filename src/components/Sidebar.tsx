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

export function Sidebar(props: {
  targets: TargetInfo[];
  currentId: string | null;
  homeDir: string;
  onSelect(id: string): void;
}) {
  const [showMissing, setShowMissing] = createSignal(false);
  const shared = createMemo(() => props.targets.filter((t) => t.kind === "shared"));
  const byName = (a: TargetInfo, b: TargetInfo) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  const agents = createMemo(() => props.targets.filter((t) => t.kind === "agent"));
  const existing = createMemo(() => agents().filter((t) => t.exists).sort(byName));
  const missing = createMemo(() => agents().filter((t) => !t.exists).sort(byName));

  const item = (t: TargetInfo) => {
    const selected = () => props.currentId === t.id;
    return (
      <button
        type="button"
        onClick={() => props.onSelect(t.id)}
        class={`group w-full rounded-2xl px-3 py-2.5 text-left transition-all duration-500 ease-fluid ${
          selected()
            ? "bg-white/[0.07] ring-1 ring-white/[0.09] shadow-[inset_0_1px_1px_rgba(255,255,255,0.06)]"
            : "hover:bg-white/[0.035] active:scale-[0.985]"
        }`}
      >
        <div class="flex items-center gap-3">
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
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-2">
              <span
                class={`truncate text-[13px] font-medium transition-colors duration-500 ${
                  selected() ? "text-[#EDEFF7]" : "text-[#B4BACC] group-hover:text-[#D6DAE5]"
                }`}
              >
                {t.label}
              </span>
              <Show when={t.exists}>
                <span
                  title="文件已创建"
                  class="size-[5px] shrink-0 rounded-full bg-mint/90 shadow-[0_0_6px_rgba(94,234,212,0.5)]"
                />
              </Show>
            </span>
            <span class="mt-0.5 block truncate font-mono text-[10.5px] leading-4 text-[#59617A]">
              {shortPath(t.path, props.homeDir)}
            </span>
          </span>
        </div>
      </button>
    );
  };

  return (
    <aside class="shell flex min-h-0 flex-col">
      <div class="flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5 py-3">
        <For each={shared()}>
          {(t) => (
            <div class="animate-fadein">{item(t)}</div>
          )}
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
              <For each={missing()}>
                {(t) => item(t)}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </aside>
  );
}
