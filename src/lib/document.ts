/**
 * Pizzic 文档模型：解析 `<pizzic-module name="…"> … </pizzic-module>`
 * 语义标签标记的模块块，并提供基于偏移量的模块操作。本文件是纯函数领域核心，
 * 不依赖 Tauri 与编辑器，偏移量与 CodeMirror 一致（UTF-16 码元）。
 *
 * 模块格式（ADR-003）：闭合的 XML 语义标签。
 *   <pizzic-module name="codegraph">            开启模块，name 必填
 *   <pizzic-module name="rtk" enabled="false">  停用态空壳（正文已移入存档）
 *   </pizzic-module>                            闭合，元素名自校验配对
 *
 * 约束：
 * - 标签必须位于行首（允许前置空白），行内出现的标签视为普通文本，防止讲解性文字误配对；
 * - fenced code block（``` 与 ~~~）内的标签不参与解析；
 * - name 满足 [A-Za-z0-9][A-Za-z0-9_-]*，属性值一律双引号；
 * - 模块扁平、不允许嵌套：未闭合时遇到新的开标签，放弃上一块从此处重开；
 * - 文件包含 <!DOCTYPE 或 <!ENTITY 时视为不可信 XML 载体：本解析器是扫描式的，
 *   不构建实体表、不启用外部实体，但仍拒绝解析此类文件的模块结构（全文视为普通文本）；
 * - 接受自闭合形式 <pizzic-module name="x"/> 作为空模块（生成端不产出该形态）；
 * - 只读兼容 v0.1 注释标签 <!-- Pizzic:begin:name [disabled] --> / <!-- Pizzic:end -->，
 *   任何编辑操作都会把旧块升级为 XML 语义标签（closeUpgradeEdits）。
 */

export const CLOSE_TAG = "</pizzic-module>";

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const OPEN_RE = /^[ \t]*(<pizzic-module\b[^\n>]*>)/gm;
const CLOSE_RE = /^[ \t]*(<\/pizzic-module\s*>)/gm;
const LEGACY_OPEN_RE = /<!--\s*Pizzic:begin:([A-Za-z0-9][A-Za-z0-9_-]*)([^\n>]*?)-->/g;
const LEGACY_CLOSE_RE = /<!--\s*Pizzic:end\s*-->/g;
const FENCE_OPEN_RE = /^[ \t]*(`{3,}|~{3,})[^\n]*$/gm;
const CLOSING_FENCE_RE = /^([`~])\1{2,}$/;
const XML_THREAT_RE = /<!\s*(?:DOCTYPE|ENTITY)/i;

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
  /** begin 标签区间（指向 "<"） */
  beginStart: number;
  beginEnd: number;
  /** 正文区间 */
  bodyStart: number;
  bodyEnd: number;
  /** 闭合标签区间（自闭合或未闭合的块此区间为空） */
  endStart: number;
  endEnd: number;
  body: string;
  /** 是否为 v0.1 旧注释格式的块（只读兼容，编辑时升级为 XML 语义标签） */
  legacy: boolean;
}

export type Seg = FreeSeg | ModuleSeg;

export interface ParsedDoc {
  segs: Seg[];
  modules: ModuleSeg[];
}

/** 扫描式解析不处理实体，但仍显式拒绝 DOCTYPE/ENTITY 载体（含 XXE 注入形态的文件）。 */
export function hasXmlThreat(text: string): boolean {
  return XML_THREAT_RE.test(text);
}

/** 收集 fenced code block 区间，其中的模块标签不参与解析。 */
function fenceRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let open: { char: string; len: number; start: number } | null = null;
  let lineStart = 0;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = text.length;
    const line = text.slice(lineStart, lineEnd + 1);
    const m = line.match(/^[ \t]*(`{3,}|~{3,})/);
    if (m) {
      const fence = m[1]!;
      if (!open) {
        open = { char: fence[0]!, len: fence.length, start: lineStart };
      } else {
        // 闭合栏：与开栏同字符、长度不小于开栏、行内无信息串
        const trimmed = line.trim();
        const closing = trimmed.match(CLOSING_FENCE_RE);
        if (closing && closing[1] === open.char && trimmed.length >= open.len) {
          ranges.push([open.start, lineEnd + 1]);
          open = null;
        }
      }
    }
    if (lineEnd >= text.length) break;
    lineStart = lineEnd + 1;
  }
  if (open) ranges.push([open.start, text.length]);
  return ranges;
}

interface OpenEvent {
  kind: "open";
  at: number;
  end: number;
  name: string;
  enabled: boolean;
  selfClosing: boolean;
  legacy: boolean;
}

interface CloseEvent {
  kind: "close";
  at: number;
  end: number;
  legacy: boolean;
}

type Ev = OpenEvent | CloseEvent;

function parseAttrs(raw: string): { name: string; enabled: boolean; selfClosing: boolean } | null {
  let s = raw.trim();
  const selfClosing = s.endsWith("/");
  if (selfClosing) s = s.slice(0, -1);
  const nm = s.match(/\bname\s*=\s*"([^"]*)"/);
  if (!nm || !NAME_RE.test(nm[1]!)) return null;
  const em = s.match(/\benabled\s*=\s*"([^"]*)"/);
  return { name: nm[1]!, enabled: em ? em[1] !== "false" : true, selfClosing };
}

export function buildBeginTag(name: string, enabled: boolean): string {
  // 深度防御：name 必须满足 NAME_RE（不含引号/尖括号/空白），保证标签结构不可被注入。
  if (!NAME_RE.test(name)) {
    throw new Error(`非法模块名: ${name}`);
  }
  return enabled
    ? `<pizzic-module name="${name}">`
    : `<pizzic-module name="${name}" enabled="false">`;
}

export function parseDoc(text: string): ParsedDoc {
  const segs: Seg[] = [];
  const modules: ModuleSeg[] = [];
  const whole = (): ParsedDoc => {
    segs.push({ kind: "free", start: 0, end: text.length, text });
    return { segs, modules };
  };
  if (hasXmlThreat(text)) return whole();

  const fences = fenceRanges(text);
  const inFence = (pos: number) => fences.some(([a, b]) => pos >= a && pos < b);
  const events: Ev[] = [];

  for (const m of text.matchAll(OPEN_RE)) {
    const tag = m[1]!;
    const at = m.index! + m[0].indexOf("<");
    if (inFence(at)) continue;
    const attrs = parseAttrs(tag.slice("<pizzic-module".length, -1));
    if (!attrs) continue;
    events.push({
      kind: "open",
      at,
      end: at + tag.length,
      name: attrs.name,
      enabled: attrs.enabled,
      selfClosing: attrs.selfClosing,
      legacy: false,
    });
  }
  for (const m of text.matchAll(CLOSE_RE)) {
    const tag = m[1]!;
    const at = m.index! + m[0].indexOf("<");
    if (inFence(at)) continue;
    events.push({ kind: "close", at, end: at + tag.length, legacy: false });
  }
  for (const m of text.matchAll(LEGACY_OPEN_RE)) {
    events.push({
      kind: "open",
      at: m.index!,
      end: m.index! + m[0].length,
      name: m[1]!,
      enabled: !/\bdisabled\b/.test(m[2] ?? ""),
      selfClosing: false,
      legacy: true,
    });
  }
  for (const m of text.matchAll(LEGACY_CLOSE_RE)) {
    events.push({
      kind: "close",
      at: m.index!,
      end: m.index! + m[0].length,
      legacy: true,
    });
  }
  events.sort((a, b) => a.at - b.at);

  let last = 0;
  let open: { name: string; enabled: boolean; legacy: boolean; beginStart: number; beginEnd: number } | null =
    null;

  const pushFree = (to: number) => {
    if (to > last) {
      segs.push({ kind: "free", start: last, end: to, text: text.slice(last, to) });
    }
  };
  const pushModule = (
    name: string,
    enabled: boolean,
    legacy: boolean,
    beginStart: number,
    beginEnd: number,
    endStart: number,
    endEnd: number,
  ) => {
    const seg: ModuleSeg = {
      kind: "module",
      name,
      enabled,
      legacy,
      beginStart,
      beginEnd,
      bodyStart: beginEnd,
      bodyEnd: endStart,
      endStart,
      endEnd,
      body: text.slice(beginEnd, endStart),
    };
    segs.push(seg);
    modules.push(seg);
  };

  for (const ev of events) {
    if (ev.kind === "open") {
      pushFree(ev.at);
      // 扁平约束：出现嵌套开标签时放弃未闭合的上一块，从这里开新模块。
      open = {
        name: ev.name,
        enabled: ev.enabled,
        legacy: ev.legacy,
        beginStart: ev.at,
        beginEnd: ev.end,
      };
      last = ev.end;
      if (ev.selfClosing) {
        pushModule(ev.name, ev.enabled, false, ev.at, ev.end, ev.end, ev.end);
        open = null;
      } else {
        // 同行紧贴闭合：<pizzic-module …></pizzic-module>，等价于空模块
        const inlineClose = text.slice(ev.end).match(/^<\/pizzic-module\s*>/);
        if (inlineClose) {
          pushModule(ev.name, ev.enabled, false, ev.at, ev.end, ev.end, ev.end + inlineClose[0].length);
          last = ev.end + inlineClose[0].length;
          open = null;
        }
      }
    } else if (open) {
      pushModule(
        open.name,
        open.enabled,
        open.legacy && ev.legacy,
        open.beginStart,
        open.beginEnd,
        ev.at,
        ev.end,
      );
      open = null;
      last = ev.end;
    }
    // 游离的闭合标签视为普通文本，不消费。
  }

  if (open) {
    // begin 未闭合：正文一直延伸到文末。
    pushModule(open.name, open.enabled, open.legacy, open.beginStart, open.beginEnd, text.length, text.length);
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
export function makeModuleBlock(name: string, body: string, enabled = true): string {
  const inner = ensureBodyNewline(body.trim() === "" ? "" : body.trimStart());
  return `${buildBeginTag(name, enabled)}\n${inner}${CLOSE_TAG}\n`;
}

export interface Edit {
  from: number;
  to: number;
  insert: string;
}

/** v0.1 旧注释格式的闭合标签升级为 XML 语义标签；新格式的块返回空。 */
export function closeUpgradeEdits(m: ModuleSeg): Edit[] {
  return m.legacy && m.endEnd > m.endStart
    ? [{ from: m.endStart, to: m.endEnd, insert: CLOSE_TAG }]
    : [];
}

/** 停用模块：正文从文档中移除（调用方负责先存档），开标签补 enabled="false"。 */
export function disableEdits(m: ModuleSeg): Edit[] {
  return [
    { from: m.beginStart, to: m.beginEnd, insert: buildBeginTag(m.name, false) },
    // 保留一个换行，让闭合标签保持行首（行首约束要求），壳呈现为两行
    { from: m.bodyStart, to: m.bodyEnd, insert: "\n" },
  ];
}

/** 启用模块：插入存档正文（可为空），去掉 enabled="false"。 */
export function enableEdits(m: ModuleSeg, stored: string | undefined): Edit[] {
  return [
    { from: m.beginStart, to: m.beginEnd, insert: buildBeginTag(m.name, true) },
    { from: m.bodyStart, to: m.bodyEnd, insert: ensureBodyNewline(stored ?? "") },
  ];
}

/** 重命名模块：只改开标签中的 name 属性。 */
export function renameEdit(m: ModuleSeg, newName: string): Edit {
  return { from: m.beginStart, to: m.beginEnd, insert: buildBeginTag(newName, m.enabled) };
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
    { from: selFrom, to: selFrom, insert: `${buildBeginTag(name, true)}\n` },
    { from: selTo, to: selTo, insert: `\n${CLOSE_TAG}\n` },
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
