import { Show } from "solid-js";

export interface StatusFlash {
  text: string;
  tone: "ok" | "warn";
}

export function StatusBar(props: {
  encoding: string | null;
  lineEnding: string | null;
  dirty: boolean;
  lines: number;
  chars: number;
  flash: StatusFlash | null;
}) {
  return (
    <footer class="shell flex h-9 shrink-0 items-center gap-2.5 px-4">
      <i class="ph-light ph-file-text text-[12px] text-[#59617A]" />
      <span class="font-mono text-[10.5px] text-[#77809A]">{props.encoding ?? "—"}</span>
      <span class="h-3 w-px bg-white/[0.08]" />
      <span
        class="font-mono text-[10.5px] text-[#77809A]"
        title="文件换行符模式（加载时自动识别，保存时保持不变）"
      >
        {props.lineEnding ?? "—"}
      </span>

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
