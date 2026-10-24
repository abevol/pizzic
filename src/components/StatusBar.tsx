import { Show } from "solid-js";
import { shortPath } from "./Sidebar";

export interface StatusFlash {
  text: string;
  tone: "ok" | "warn";
}

export function StatusBar(props: {
  path: string | null;
  homeDir: string;
  dirty: boolean;
  lines: number;
  chars: number;
  flash: StatusFlash | null;
}) {
  return (
    <footer class="shell flex h-9 shrink-0 items-center gap-3 px-4">
      <Show
        when={props.path}
        fallback={<span class="text-[11px] text-[#4E5670]">未选择文件</span>}
      >
        <i class="ph-light ph-file-text text-[12px] text-[#59617A]" />
        <span
          dir="rtl"
          class="min-w-0 max-w-[46%] truncate font-mono text-[10.5px] text-[#77809A]"
          title={props.path ?? ""}
        >
          {shortPath(props.path ?? "", props.homeDir)}
        </span>
      </Show>

      <span class="flex-1" />

      <Show when={props.flash}>
        {(f) => (
          <span
            class={`animate-fadein text-[11px] ${f().tone === "warn" ? "text-[#FCD34D]" : "text-mint"}`}
          >
            {f().text}
          </span>
        )}
      </Show>

      <span class="font-mono text-[10.5px] text-[#4E5670]">
        {props.lines} 行 · {props.chars} 字符
      </span>

      <span class="flex items-center gap-1.5">
        <span
          class={`size-[6px] rounded-full transition-all duration-500 ${
            props.dirty
              ? "bg-accent shadow-[0_0_8px_rgba(167,139,250,0.7)] animate-pulse"
              : "bg-mint/80"
          }`}
        />
        <span
          class={`text-[11px] transition-colors duration-500 ${
            props.dirty ? "text-accent-2" : "text-[#8A91A6]"
          }`}
        >
          {props.dirty ? "未保存" : "已同步"}
        </span>
      </span>
    </footer>
  );
}
