import { Show, createEffect, onCleanup } from "solid-js";

export interface ConfirmSpec {
  title: string;
  body: string;
  confirmText?: string;
  /** 取消位文案；默认「取消」。用于表达「保留旧文件」这类非否定语义。 */
  cancelText?: string;
  danger?: boolean;
  onConfirm(): void;
}

export function ConfirmModal(props: { spec: ConfirmSpec | null; onCancel(): void }) {
  createEffect(() => {
    if (!props.spec) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onCancel();
    };
    document.addEventListener("keydown", handler);
    onCleanup(() => document.removeEventListener("keydown", handler));
  });

  return (
    <Show when={props.spec}>
      {(spec) => (
        <div
          class="fixed inset-0 z-50 grid place-items-center bg-black/55 backdrop-blur-md transition-opacity duration-300"
          onClick={props.onCancel}
        >
          <div class="double-bezel animate-rise w-[400px]" onClick={(e) => e.stopPropagation()}>
            <div class="rounded-[calc(1.6rem_-_6px)] bg-[#0C0E13] p-6 shadow-[inset_0_1px_1px_rgba(255,255,255,0.05)]">
              <div class="flex items-start gap-3">
                <span
                  class={`grid size-9 shrink-0 place-items-center rounded-2xl ${
                    spec().danger
                      ? "bg-[#E5484D]/12 ring-1 ring-[#E5484D]/25"
                      : "bg-accent/12 ring-1 ring-accent/25"
                  }`}
                >
                  <i
                    class={`ph-light text-[18px] ${spec().danger ? "ph-warning text-[#FB7185]" : "ph-question text-accent-2"}`}
                  />
                </span>
                <div class="min-w-0">
                  <h2 class="text-[15px] font-semibold text-[#EDEFF7]">{spec().title}</h2>
                  <p class="mt-1.5 whitespace-pre-line text-[12.5px] leading-relaxed text-[#8A91A6]">
                    {spec().body}
                  </p>
                </div>
              </div>
              <div class="mt-6 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={props.onCancel}
                  class="h-9 rounded-full px-5 text-[12.5px] text-[#8A91A6] transition-all duration-500 ease-fluid hover:bg-white/[0.06] hover:text-[#D6DAE5] active:scale-[0.97]"
                >
                  {spec().cancelText ?? "取消"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const fn = spec().onConfirm;
                    props.onCancel();
                    fn();
                  }}
                  class={`h-9 rounded-full px-5 text-[12.5px] font-medium transition-all duration-500 ease-fluid active:scale-[0.97] ${
                    spec().danger
                      ? "bg-[#E5484D]/85 text-white hover:bg-[#E5484D]"
                      : "bg-gradient-to-r from-[#8B5CF6] to-[#6EE7D8] text-ink-950 hover:brightness-110"
                  }`}
                >
                  {spec().confirmText ?? "确认"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
