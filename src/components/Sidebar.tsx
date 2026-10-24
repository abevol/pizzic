import { For, createMemo } from "solid-js";
import type { TargetInfo } from "../lib/api";

const AGENT_ICONS: Record<string, string> = {
  claude: "ph-sparkle",
  codex: "ph-terminal-window",
  opencode: "ph-brackets",
  dsh: "ph-pulse",
  zcode: "ph-lightning",
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
  const shared = createMemo(() => props.targets.filter((t) => t.kind === "shared"));
  const agents = createMemo(() => props.targets.filter((t) => t.kind === "agent"));

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
              <span
                title={t.exists ? "文件已创建" : "文件未创建"}
                class={`size-[5px] shrink-0 rounded-full transition-all duration-500 ${
                  t.exists ? "bg-mint/90 shadow-[0_0_6px_rgba(94,234,212,0.5)]" : "bg-white/[0.14]"
                }`}
              />
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

        <div class="flex flex-col gap-1">
          <For each={agents()}>
            {(t, i) => (
              <div class="animate-rise" style={{ "animation-delay": `${80 + i() * 55}ms` }}>
                {item(t)}
              </div>
            )}
          </For>
        </div>
      </div>
    </aside>
  );
}
