/**
 * 解析器行为自检：node --experimental-strip-types scripts/dev-check.ts
 *
 * applyEdits 与 CodeMirror 的多段 dispatch 语义一致：所有偏移都基于同一份
 * 原文本，按位置倒序应用以避免漂移。
 */
import {
  appendModuleEdit,
  deleteEdit,
  disableEdits,
  enableEdits,
  makeModuleBlock,
  nextModuleName,
  parseDoc,
  renameEdit,
  wrapSelectionEdits,
  type Edit,
} from "../src/lib/document.ts";

function applyEdits(text: string, edits: Edit[]): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  }
  return out;
}

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${msg}`);
  }
}

// 1. 基本解析：两个模块 + 游离文本
const doc1 = [
  "## 系统信息",
  "",
  "<!-- Pizzic:begin:codegraph -->",
  "## CodeGraph",
  "代码检索说明。",
  "<!-- Pizzic:end -->",
  "",
  "<!-- Pizzic:begin:rtk disabled -->",
  "<!-- Pizzic:end -->",
  "",
  "结尾自由文本",
].join("\n");

const p1 = parseDoc(doc1);
assert(p1.modules.length === 2, "解析出 2 个模块");
assert(p1.modules[0]!.name === "codegraph", "第一个模块名为 codegraph");
assert(p1.modules[0]!.enabled === true, "codegraph 为启用态");
assert(p1.modules[0]!.body.includes("## CodeGraph"), "启用模块正文正确");
assert(p1.modules[0]!.body.includes("代码检索说明。"), "模块正文偏移正确");
assert(p1.modules[1]!.enabled === false, "disabled 属性被识别");
assert(p1.modules[1]!.body.trim() === "", "停用壳正文为空");
assert(p1.segs.some((s) => s.kind === "free" && s.text.includes("结尾自由文本")), "游离文本保留");
assert(
  doc1.slice(p1.modules[0]!.bodyStart, p1.modules[0]!.bodyEnd) === p1.modules[0]!.body,
  "正文偏移与切片一致",
);

// 2. 停用 → 存档 → 重新启用：正文应完整恢复
const m0 = p1.modules[0]!;
const original = m0.body;
const disabledText = applyEdits(doc1, disableEdits(m0));
const p2 = parseDoc(disabledText);
const m0d = p2.modules.find((m) => m.name === "codegraph");
assert(m0d !== undefined && m0d.enabled === false, "停用后解析为禁用态");
const reEnabledText = applyEdits(disabledText, enableEdits(m0d!, original));
const p3 = parseDoc(reEnabledText);
assert(
  p3.modules.find((m) => m.name === "codegraph")?.body === original,
  "重新启用后正文完整恢复",
);

// 3. 重命名与删除
const renamed = renameEdit(p3.modules.find((m) => m.name === "codegraph")!, "codegraph2");
const renamedText = applyEdits(reEnabledText, [renamed]);
assert(parseDoc(renamedText).modules[0]!.name === "codegraph2", "重命名生效");
const target = parseDoc(reEnabledText).modules[0]!;
const del = deleteEdit(target, reEnabledText);
const deletedText = applyEdits(reEnabledText, [del]);
assert(parseDoc(deletedText).modules.length === 1, "删除模块后只剩 1 个");

// 4. 选区包裹与文末注入
const base = "标题\n\n正文段落。";
const wrapped = applyEdits(base, wrapSelectionEdits(4, 10, "core"));
const pw = parseDoc(wrapped);
assert(pw.modules.length === 1 && pw.modules[0]!.name === "core", "选区包裹生成模块");
assert(pw.modules[0]!.body.trim() === base.slice(4, 10), "包裹正文正确");

const appended = applyEdits(base, [appendModuleEdit(base, "extra", "注入的内容")]);
const pa = parseDoc(appended);
assert(pa.modules.length === 1 && pa.modules[0]!.name === "extra", "文末注入生成模块");
assert(pa.modules[0]!.body.includes("注入的内容"), "注入正文正确");

// 5. CRLF 文档：解析不归一化，停用/启用逐字节往返
const crlf =
  "<!-- Pizzic:begin:win -->\r\nWindows 行一。\r\n<!-- Pizzic:end -->\r\n";
const pc = parseDoc(crlf);
assert(pc.modules.length === 1, "CRLF 文档解析出模块");
assert(
  pc.modules[0]!.body === "\r\nWindows 行一。\r\n",
  "CRLF 正文原样保真（不归一化）",
);
const crlfDisabled = applyEdits(crlf, disableEdits(pc.modules[0]!));
const crlfBack = applyEdits(
  crlfDisabled,
  enableEdits(parseDoc(crlfDisabled).modules.find((m) => m.name === "win")!, pc.modules[0]!.body),
);
assert(crlfBack === crlf, "CRLF 停用再启用逐字节往返一致");

// 6. 命名工具
assert(nextModuleName([]) === "module-1", "首个自动名 module-1");
assert(nextModuleName(["module-1", "module-3"]) === "module-2", "跳过占用名");
assert(makeModuleBlock("x", "  内容 ").endsWith("<!-- Pizzic:end -->\n"), "块序列化格式正确");

console.log(process.exitCode ? "\n自检失败" : "\n全部通过");
