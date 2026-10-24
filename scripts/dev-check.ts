/**
 * 解析器行为自检：node --experimental-strip-types scripts/dev-check.ts
 *
 * applyEdits 与 CodeMirror 的多段 dispatch 语义一致：所有偏移都基于同一份
 * 原文本，按位置倒序应用以避免漂移。
 */
import {
  appendModuleEdit,
  buildBeginTag,
  CLOSE_TAG,
  closeUpgradeEdits,
  deleteEdit,
  disableEdits,
  enableEdits,
  hasXmlThreat,
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
  '<pizzic-module name="codegraph">',
  "## CodeGraph",
  "代码检索说明。",
  "</pizzic-module>",
  "",
  '<pizzic-module name="rtk" enabled="false">',
  "</pizzic-module>",
  "",
  "结尾自由文本",
].join("\n");

const p1 = parseDoc(doc1);
assert(p1.modules.length === 2, "解析出 2 个模块");
assert(p1.modules[0]!.name === "codegraph", "第一个模块名为 codegraph");
assert(p1.modules[0]!.enabled === true, "codegraph 为启用态");
assert(p1.modules[0]!.body.includes("## CodeGraph"), "启用模块正文正确");
assert(p1.modules[0]!.body.includes("代码检索说明。"), "模块正文偏移正确");
assert(p1.modules[1]!.enabled === false, 'enabled="false" 被识别');
assert(p1.modules[1]!.body.trim() === "", "停用壳正文为空");
assert(p1.modules.every((m) => !m.legacy), "新格式块不带 legacy 标志");
assert(p1.segs.some((s) => s.kind === "free" && s.text.includes("结尾自由文本")), "游离文本保留");
assert(
  doc1.slice(p1.modules[0]!.bodyStart, p1.modules[0]!.bodyEnd) === p1.modules[0]!.body,
  "正文偏移与切片一致",
);

// 2. 属性顺序无关 + 自闭合
const p2 = parseDoc('<pizzic-module enabled="false" name="abc"></pizzic-module>');
assert(p2.modules.length === 1 && p2.modules[0]!.name === "abc" && !p2.modules[0]!.enabled, "属性顺序无关解析");
const p3 = parseDoc('<pizzic-module name="self"/>');
assert(p3.modules.length === 1 && p3.modules[0]!.name === "self" && p3.modules[0]!.body === "", "自闭合解析为空模块");

// 3. 停用 → 存档 → 重新启用：正文应完整恢复
const m0 = p1.modules[0]!;
const original = m0.body;
const disabledText = applyEdits(doc1, disableEdits(m0));
const p4 = parseDoc(disabledText);
const m0d = p4.modules.find((m) => m.name === "codegraph");
assert(m0d !== undefined && m0d.enabled === false, "停用后解析为禁用态");
const reEnabledText = applyEdits(disabledText, enableEdits(m0d!, original));
const p5 = parseDoc(reEnabledText);
assert(
  p5.modules.find((m) => m.name === "codegraph")?.body === original,
  "重新启用后正文完整恢复",
);

// 4. 重命名与删除
const renamed = renameEdit(p5.modules.find((m) => m.name === "codegraph")!, "codegraph2");
const renamedText = applyEdits(reEnabledText, [renamed]);
assert(parseDoc(renamedText).modules[0]!.name === "codegraph2", "重命名生效");
const target = parseDoc(reEnabledText).modules[0]!;
const del = deleteEdit(target, reEnabledText);
const deletedText = applyEdits(reEnabledText, [del]);
assert(parseDoc(deletedText).modules.length === 1, "删除模块后只剩 1 个");

// 5. 选区包裹与文末注入
const base = "标题\n\n正文段落。";
const wrapped = applyEdits(base, wrapSelectionEdits(4, 10, "core"));
const pw = parseDoc(wrapped);
assert(pw.modules.length === 1 && pw.modules[0]!.name === "core", "选区包裹生成模块");
assert(pw.modules[0]!.body.trim() === base.slice(4, 10), "包裹正文正确");

const appended = applyEdits(base, [appendModuleEdit(base, "extra", "注入的内容")]);
const pa = parseDoc(appended);
assert(pa.modules.length === 1 && pa.modules[0]!.name === "extra", "文末注入生成模块");
assert(pa.modules[0]!.body.includes("注入的内容"), "注入正文正确");

// 6. 命名工具与标签生成
assert(nextModuleName([]) === "module-1", "首个自动名 module-1");
assert(nextModuleName(["module-1", "module-3"]) === "module-2", "跳过占用名");
assert(makeModuleBlock("x", "  内容 ").endsWith(CLOSE_TAG + "\n"), "块序列化以闭合标签结尾");
assert(buildBeginTag("x", false) === '<pizzic-module name="x" enabled="false">', "停用开标签格式正确");
let threw = false;
try {
  buildBeginTag('x" onerror="1', true);
} catch {
  threw = true;
}
assert(threw, "非法模块名被拒绝（防标签注入）");

// 7. CRLF 文档：解析不归一化，停用/启用逐字节往返
const crlf =
  '<pizzic-module name="win">\r\nWindows 行一。\r\n</pizzic-module>\r\n';
const pc = parseDoc(crlf);
assert(pc.modules.length === 1, "CRLF 文档解析出模块");
assert(pc.modules[0]!.body === "\r\nWindows 行一。\r\n", "CRLF 正文原样保真（不归一化）");
const crlfDisabled = applyEdits(crlf, disableEdits(pc.modules[0]!));
const crlfBack = applyEdits(
  crlfDisabled,
  enableEdits(parseDoc(crlfDisabled).modules.find((m) => m.name === "win")!, pc.modules[0]!.body),
);
assert(crlfBack === crlf, "CRLF 停用再启用逐字节往返一致");

// 8. v0.1 旧注释格式：只读兼容 + 编辑升级
const legacy =
  "<!-- Pizzic:begin:old-mod -->\n旧正文。\n<!-- Pizzic:end -->\n";
const pl = parseDoc(legacy);
assert(pl.modules.length === 1 && pl.modules[0]!.name === "old-mod" && pl.modules[0]!.legacy, "旧注释格式兼容解析");
assert(pl.modules[0]!.body === "\n旧正文。\n", "旧格式正文正确");
const upgraded = applyEdits(legacy, [...disableEdits(pl.modules[0]!), ...closeUpgradeEdits(pl.modules[0]!)]);
const pu = parseDoc(upgraded);
assert(
  pu.modules.length === 1 &&
    pu.modules[0]!.name === "old-mod" &&
    !pu.modules[0]!.legacy &&
    !pu.modules[0]!.enabled,
  "旧块停用后整体升级为 XML 语义标签",
);
const legacyRe = applyEdits(
  upgraded,
  [...enableEdits(pu.modules[0]!, pl.modules[0]!.body), ...closeUpgradeEdits(pu.modules[0]!)],
);
const pr = parseDoc(legacyRe);
assert(!pr.modules[0]!.legacy && pr.modules[0]!.body === "\n旧正文。\n", "升级后的旧块可正常恢复正文");

// 9. 行首约束：行内出现的标签不参与解析
const inline = '讲解：写 <pizzic-module name="fake"> 与 </pizzic-module> 只是文字。';
assert(parseDoc(inline).modules.length === 0, "行内标签被忽略（行首约束）");

// 10. fenced code block 内的标签不参与解析
const fenced = [
  "示例：",
  "```markdown",
  '<pizzic-module name="demo">',
  "内容",
  "</pizzic-module>",
  "```",
  "",
  '<pizzic-module name="real">',
  "真模块",
  "</pizzic-module>",
].join("\n");
const pf = parseDoc(fenced);
assert(pf.modules.length === 1 && pf.modules[0]!.name === "real", "围栏内的标签被忽略");

// 11. DOCTYPE/ENTITY 载体拒绝解析
const threat = '<!DOCTYPE pizzic-module [<!ENTITY x "y">]>\n<pizzic-module name="x">a</pizzic-module>';
assert(hasXmlThreat(threat), "DOCTYPE/ENTITY 被识别为威胁");
assert(parseDoc(threat).modules.length === 0, "威胁文件不解析模块结构");

// 12. 未闭合容错与嵌套容错
const unclosed = '<pizzic-module name="eof">\n正文到文末';
const punc = parseDoc(unclosed);
assert(punc.modules.length === 1 && punc.modules[0]!.body === "\n正文到文末", "未闭合模块延伸到文末");
const nested = '<pizzic-module name="a">\n<pizzic-module name="b">\nx\n</pizzic-module>';
const pnest = parseDoc(nested);
assert(pnest.modules.length === 1 && pnest.modules[0]!.name === "b", "嵌套开标签容错：放弃上一块");

console.log(process.exitCode ? "\n自检失败" : "\n全部通过");
