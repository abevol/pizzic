/**
 * 解析器行为自检：node --experimental-strip-types scripts/dev-check.ts
 *
 * applyEdits 与 CodeMirror 的多段 dispatch 语义一致：所有偏移都基于同一份
 * 原文本，按位置倒序应用以避免漂移。
 */
import {
  appendModuleEdit,
  applyEdits,
  buildBeginTag,
  CLOSE_TAG,
  deleteEdit,
  insertAfterModuleEdit,
  makeModuleBlock,
  nextModuleName,
  parseDoc,
  renameEdit,
  wrapSelectionEdits,
  type Edit,
} from "../src/lib/document.ts";

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
assert(p1.modules[1]!.enabled === false, 'enabled="false" 壳仍可解析（兼容读取）');
assert(p1.segs.some((s) => s.kind === "free" && s.text.includes("结尾自由文本")), "游离文本保留");
assert(
  doc1.slice(p1.modules[0]!.bodyStart, p1.modules[0]!.bodyEnd) === p1.modules[0]!.body,
  "正文偏移与切片一致",
);

// 2. 属性顺序无关 + 自闭合 + name 内部空格
const p2 = parseDoc('<pizzic-module enabled="false" name="abc"></pizzic-module>');
assert(p2.modules.length === 1 && p2.modules[0]!.name === "abc" && !p2.modules[0]!.enabled, "属性顺序无关解析");
const p3 = parseDoc('<pizzic-module name="self"/>');
assert(p3.modules.length === 1 && p3.modules[0]!.name === "self" && p3.modules[0]!.body === "", "自闭合解析为空模块");
const pSpace = parseDoc('<pizzic-module name="rtk-instructions v1">\n正文\n</pizzic-module>');
assert(
  pSpace.modules.length === 1 && pSpace.modules[0]!.name === "rtk-instructions v1",
  "name 支持内部空格",
);
assert(
  parseDoc('<pizzic-module name=" x">a</pizzic-module>').modules.length === 0 &&
    parseDoc('<pizzic-module name="x ">a</pizzic-module>').modules.length === 0,
  "首尾空格的 name 仍被拒绝",
);

// 3. ADR-004 停用语义：整块移除，启用按位置锚插回
const m0 = p1.modules[0]!;
const original = m0.body;
const afterAnchor = "rtk"; // 前驱锚取自前一个模块（示例中为壳）
const removed = applyEdits(doc1, [deleteEdit(m0, doc1)]);
assert(parseDoc(removed).modules.length === 1, "停用后模块从文档中整块移除");
assert(!removed.includes('name="codegraph"'), "文档中不再保留任何占位标签");
const reEnabledText = applyEdits(removed, [
  insertAfterModuleEdit(removed, "codegraph-anchor-x", "codegraph", original), // 锚不存在 → 落文末
]);
const p5 = parseDoc(reEnabledText);
const restored = p5.modules.find((m) => m.name === "codegraph");
assert(restored !== undefined && restored!.body === original, "启用后正文完整恢复（锚缺失落文末）");
const reAnchoredText = applyEdits(removed, [
  insertAfterModuleEdit(removed, "rtk", "codegraph", original),
]);
const pAnchored = parseDoc(reAnchoredText);
assert(
  pAnchored.modules[pAnchored.modules.length - 1]!.name === "codegraph",
  "按前驱锚插回：恢复到锚模块之后",
);

// 4. 重命名与删除
const renamed = renameEdit(restored!, "codegraph2");
const renamedText = applyEdits(reEnabledText, [renamed]);
assert(parseDoc(renamedText).modules.some((m) => m.name === "codegraph2"), "重命名生效");
const del = deleteEdit(parseDoc(reEnabledText).modules.find((m) => m.name === "codegraph")!, reEnabledText);
assert(parseDoc(applyEdits(reEnabledText, [del])).modules.length === 1, "删除模块后只剩 1 个");

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
assert(buildBeginTag("x", false) === '<pizzic-module name="x" enabled="false">', "停用开标签格式正确（仅解析宽容用）");
let threw = false;
try {
  buildBeginTag('x" onerror="1', true);
} catch {
  threw = true;
}
assert(threw, "非法模块名被拒绝（防标签注入）");

// 7. CRLF 文档：解析不归一化，停用/启用语义正确
const crlf =
  '<pizzic-module name="win">\r\nWindows 行一。\r\n</pizzic-module>\r\n';
const pc = parseDoc(crlf);
assert(pc.modules.length === 1, "CRLF 文档解析出模块");
assert(pc.modules[0]!.body === "\r\nWindows 行一。\r\n", "CRLF 正文原样保真（不归一化）");
const crlfRemoved = applyEdits(crlf, [deleteEdit(pc.modules[0]!, crlf)]);
assert(parseDoc(crlfRemoved).modules.length === 0, "CRLF 文档停用后整块移除");
const crlfBack = applyEdits(crlfRemoved, [
  insertAfterModuleEdit(crlfRemoved, "win", "win", pc.modules[0]!.body),
]);
assert(parseDoc(crlfBack).modules[0]!.body.includes("Windows 行一。"), "CRLF 文档启用后正文恢复");

// 8. v0.1 旧注释格式：只读兼容；ADR-004 下停用即整块移除
const legacy =
  "<!-- Pizzic:begin:old-mod -->\n旧正文。\n<!-- Pizzic:end -->\n";
const pl = parseDoc(legacy);
assert(pl.modules.length === 1 && pl.modules[0]!.name === "old-mod" && pl.modules[0]!.legacy, "旧注释格式兼容解析");
assert(pl.modules[0]!.body === "\n旧正文。\n", "旧格式正文正确");
const legacyRemoved = applyEdits(legacy, [deleteEdit(pl.modules[0]!, legacy)]);
assert(parseDoc(legacyRemoved).modules.length === 0, "旧块停用即整块移除");

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
assert(parseDoc(threat).modules.length === 0, "威胁文件不解析模块结构");

// 12. 未闭合容错与嵌套容错
const unclosed = '<pizzic-module name="eof">\n正文到文末';
const punc = parseDoc(unclosed);
assert(punc.modules.length === 1 && punc.modules[0]!.body === "\n正文到文末", "未闭合模块延伸到文末");
const nested = '<pizzic-module name="a">\n<pizzic-module name="b">\nx\n</pizzic-module>';
const pnest = parseDoc(nested);
assert(pnest.modules.length === 1 && pnest.modules[0]!.name === "b", "嵌套开标签容错：放弃上一块");

console.log(process.exitCode ? "\n自检失败" : "\n全部通过");
