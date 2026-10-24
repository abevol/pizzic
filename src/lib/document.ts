/**
 * Pizzic 文档模型：解析 `<!-- Pizzic:begin:<name> --> … <!-- Pizzic:end -->`
 * 标记的模块块，并提供基于偏移量的模块操作。本文件是纯函数领域核心，
 * 不依赖 Tauri 与编辑器，偏移量与 CodeMirror 一致（UTF-16 码元）。
 *
 * 标签语法：
 *   <!-- Pizzic:begin:codegraph -->        开启名为 codegraph 的模块
 *   <!-- Pizzic:begin:codegraph disabled --> 停用态空壳（正文已移入存档）
 *   <!-- Pizzic:end -->                    模块结束（不带名字，配对最近的 begin）
 */

export const BEGIN_TAG_PREFIX = "<!-- Pizzic:begin:";
export const END_TAG = "<!-- Pizzic:end -->";

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const TAG_RE =
  /<!--\s*Pizzic:(?:(begin)\s*:\s*([A-Za-z0-9][A-Za-z0-9_-]*)([^\n>]*?)|(end)\s*?)-->/g;

export interface FreeSeg {
  kind: "free";
  start: number;
  end: number;
  text: string;
}

export interface ModuleSeg {
  kind: "module";
  name: string;
  enabled: boolean;
  /** begin 标签区间 */
  beginStart: number;
  beginEnd: number;
  /** 正文区间 */
  bodyStart: number;
  bodyEnd: number;
  /** end 标签区间 */
  endStart: number;
  endEnd: number;
  body: string;
}

export type Seg = FreeSeg | ModuleSeg;

export interface ParsedDoc {
  segs: Seg[];
  modules: ModuleSeg[];
}

export function isDisabledAttr(attrs: string | undefined): boolean {
  return /\bdisabled\b/.test(attrs ?? "");
}

export function buildBeginTag(name: string, disabled: boolean): string {
  return `${BEGIN_TAG_PREFIX}${name}${disabled ? " disabled" : ""} -->`;
}

export function parseDoc(text: string): ParsedDoc {
  const segs: Seg[] = [];
  const modules: ModuleSeg[] = [];
  let last = 0;
  let open: {
    name: string;
    disabled: boolean;
    beginStart: number;
    beginEnd: number;
  } | null = null;

  const pushFree = (to: number) => {
    if (to > last) {
      segs.push({ kind: "free", start: last, end: to, text: text.slice(last, to) });
    }
  };

  for (const m of text.matchAll(TAG_RE)) {
    const idx = m.index!;
    if (m[1] === "begin") {
      pushFree(idx);
      // 出现嵌套 begin 时按容错处理：放弃未闭合的上一块，从这里开新模块。
      open = {
        name: m[2]!,
        disabled: isDisabledAttr(m[3]),
        beginStart: idx,
        beginEnd: idx + m[0].length,
      };
      last = open.beginEnd;
    } else if (open) {
      const seg: ModuleSeg = {
        kind: "module",
        name: open.name,
        enabled: !open.disabled,
        beginStart: open.beginStart,
        beginEnd: open.beginEnd,
        bodyStart: open.beginEnd,
        bodyEnd: idx,
        endStart: idx,
        endEnd: idx + m[0].length,
        body: text.slice(open.beginEnd, idx),
      };
      segs.push(seg);
      modules.push(seg);
      open = null;
      last = seg.endEnd;
    }
    // 游离的 end 标签视为普通文本，不消费。
  }

  if (open) {
    // begin 未闭合：正文一直延伸到文末。
    const seg: ModuleSeg = {
      kind: "module",
      name: open.name,
      enabled: !open.disabled,
      beginStart: open.beginStart,
      beginEnd: open.beginEnd,
      bodyStart: open.beginEnd,
      bodyEnd: text.length,
      endStart: text.length,
      endEnd: text.length,
      body: text.slice(open.beginEnd),
    };
    segs.push(seg);
    modules.push(seg);
    last = text.length;
  } else {
    pushFree(text.length);
  }

  return { segs, modules };
}

/** 模块展示名：优先取正文中第一个标题，否则用模块名本身。 */
export function moduleLabel(m: ModuleSeg): string {
  const heading = m.body.match(/^#{1,6}\s+(.+?)\s*$/m);
  if (heading) return heading[1]!.trim();
  return m.name;
}

/** 确定性的模块色相索引（用于装饰与面板配色）。 */
export function moduleHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return h % HUES.length;
}

export const HUES = [
  { name: "紫", dot: "#A78BFA", tint: "rgba(167,139,250,0.06)", rule: "rgba(167,139,250,0.45)" },
  { name: "青", dot: "#5EEAD4", tint: "rgba(94,234,212,0.055)", rule: "rgba(94,234,212,0.4)" },
  { name: "金", dot: "#FCD34D", tint: "rgba(252,211,77,0.055)", rule: "rgba(252,211,77,0.4)" },
  { name: "玫", dot: "#FB7185", tint: "rgba(251,113,133,0.055)", rule: "rgba(251,113,133,0.4)" },
  { name: "蓝", dot: "#7DD3FC", tint: "rgba(125,211,252,0.055)", rule: "rgba(125,211,252,0.4)" },
  { name: "草", dot: "#BEF264", tint: "rgba(190,242,100,0.05)", rule: "rgba(190,242,100,0.38)" },
];

function ensureBodyNewline(body: string): string {
  if (body === "") return "";
  return body.endsWith("\n") ? body : `${body}\n`;
}

/** 序列化一个模块块（供新建/注入使用），结尾始终恰好一个换行。 */
export function makeModuleBlock(name: string, body: string, disabled = false): string {
  const inner = ensureBodyNewline(body.trim() === "" ? "" : body.trimStart());
  return `${buildBeginTag(name, disabled)}\n${inner}${END_TAG}\n`;
}

export interface Edit {
  from: number;
  to: number;
  insert: string;
}

/** 停用模块：正文从文档中移除（调用方负责先存档），begin 标签补 disabled。 */
export function disableEdits(m: ModuleSeg): Edit[] {
  return [
    { from: m.beginStart, to: m.beginEnd, insert: buildBeginTag(m.name, true) },
    { from: m.bodyStart, to: m.bodyEnd, insert: "" },
  ];
}

/** 启用模块：插入存档正文（可为空），去掉 disabled。 */
export function enableEdits(m: ModuleSeg, stored: string | undefined): Edit[] {
  return [
    { from: m.beginStart, to: m.beginEnd, insert: buildBeginTag(m.name, false) },
    { from: m.bodyStart, to: m.bodyEnd, insert: ensureBodyNewline(stored ?? "") },
  ];
}

/** 重命名模块：只改 begin 标签中的名字。 */
export function renameEdit(m: ModuleSeg, newName: string): Edit {
  return { from: m.beginStart, to: m.beginEnd, insert: buildBeginTag(newName, !m.enabled) };
}

/** 删除整个模块块，连同其后一个换行。 */
export function deleteEdit(m: ModuleSeg, text: string): Edit {
  let to = m.endEnd;
  if (text[to] === "\n") to += 1;
  else if (text[to] === "\r" && text[to + 1] === "\n") to += 2;
  return { from: m.beginStart, to, insert: "" };
}

/** 把选区包成新模块。 */
export function wrapSelectionEdits(selFrom: number, selTo: number, name: string): Edit[] {
  return [
    { from: selFrom, to: selFrom, insert: `${buildBeginTag(name, false)}\n` },
    { from: selTo, to: selTo, insert: `\n${END_TAG}\n` },
  ];
}

/** 在文末追加一个模块块，吃掉原有结尾的空白并保证空行分隔。 */
export function appendModuleEdit(docText: string, name: string, body: string): Edit {
  const trimmedEnd = docText.replace(/\s+$/, "");
  const sep = trimmedEnd === "" ? "" : "\n\n";
  return {
    from: trimmedEnd.length,
    to: docText.length,
    insert: `${sep}${makeModuleBlock(name, body)}`,
  };
}

export function humanizeModuleName(name: string): string {
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

export function nextModuleName(existing: string[]): string {
  const taken = new Set(existing);
  for (let i = 1; ; i++) {
    const n = `module-${i}`;
    if (!taken.has(n)) return n;
  }
}
