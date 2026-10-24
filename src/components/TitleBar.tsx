import { getCurrentWindow } from "@tauri-apps/api/window";
import type { JSX } from "solid-js";

function WinBtn(props: { onClick(): void; danger?: boolean; children: JSX.Element }) {
  return (
    <button
      type="button"
      onClick={() => props.onClick()}
      class={`grid w-12 place-items-center text-[#77809A] transition-all duration-300 ease-fluid hover:bg-white/[0.07] hover:text-[#C9CEDA] active:scale-95 ${
        props.danger ? "hover:!bg-[#E5484D]/85 hover:!text-white" : ""
      }`}
    >
      {props.children}
    </button>
  );
}

export function TitleBar() {
  const win = getCurrentWindow();
  return (
    <header class="relative z-30 flex h-11 shrink-0 select-none items-center pl-4">
      <div class="flex items-center gap-2.5" data-tauri-drag-region>
        <span class="grid size-[22px] place-items-center rounded-[7px] bg-gradient-to-br from-[#A78BFA] via-[#8B9CF9] to-[#5EEAD4] shadow-[0_2px_10px_-2px_rgba(139,124,250,0.6)]">
          <span class="flex flex-col gap-[2.5px]">
            <span class="block h-[2.5px] w-[10px] rounded-full bg-ink-950/80" />
            <span class="block h-[2.5px] w-[10px] rounded-full bg-ink-950/50" />
            <span class="block h-[2.5px] w-[6px] rounded-full bg-ink-950/80" />
          </span>
        </span>
        <span class="text-[11px] font-semibold uppercase tracking-[0.3em] text-[#8F97AC]">
          Pizzic
        </span>
      </div>
      <div class="h-full flex-1" data-tauri-drag-region />
      <div class="flex h-full items-stretch">
        <WinBtn onClick={() => void win.minimize()}>
          <i class="ph-light ph-minus text-[13px]" />
        </WinBtn>
        <WinBtn onClick={() => void win.toggleMaximize()}>
          <i class="ph-light ph-square text-[10px]" />
        </WinBtn>
        <WinBtn danger onClick={() => void win.close()}>
          <i class="ph-light ph-x text-[15px]" />
        </WinBtn>
      </div>
    </header>
  );
}
