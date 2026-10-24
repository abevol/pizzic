// 实证 @codemirror/state 的换行符行为：node scripts/cm-eol-probe.mjs
import { EditorState } from "@codemirror/state";

const CRLF = "x\r\ny\r\nz";

// A. 默认配置，dispatch 插入 CRLF
const a = EditorState.create({ doc: "" });
const ta = a.update({ changes: { from: 0, to: 0, insert: CRLF } });
console.log("A 默认 + dispatch(CRLF):", JSON.stringify(ta.state.doc.toString()));

// B. lineSeparator=\r\n，dispatch 插入 CRLF（我上一轮修复的路径）
const b = EditorState.create({
  doc: "",
  extensions: EditorState.lineSeparator.of("\r\n"),
});
const tb = b.update({ changes: { from: 0, to: 0, insert: CRLF } });
console.log("B sep=CRLF + dispatch(CRLF):", JSON.stringify(tb.state.doc.toString()));

// C. lineSeparator=\r\n，create 时直接给 CRLF 文本
const c = EditorState.create({
  doc: CRLF,
  extensions: EditorState.lineSeparator.of("\r\n"),
});
console.log("C sep=CRLF + create(CRLF):", JSON.stringify(c.doc.toString()));

// D. 默认配置，create 时给 CRLF 文本
const d = EditorState.create({ doc: CRLF });
console.log("D 默认 + create(CRLF):", JSON.stringify(d.doc.toString()));

// E. 模拟我的实际接线：先 reconfigure lineSeparator，再 replaceDoc（dispatch 全量替换）
const comp = (await import("@codemirror/state")).Compartment;
const sepComp = new comp();
const e = EditorState.create({ doc: "", extensions: sepComp.of([]) });
const e2 = e.update({ effects: sepComp.reconfigure(EditorState.lineSeparator.of("\r\n")) }).state;
const e3 = e2.update({ changes: { from: 0, to: 0, insert: CRLF } }).state;
console.log("E reconfigure→dispatch:", JSON.stringify(e3.doc.toString()));
console.log("E facet 值:", JSON.stringify(e3.facet(EditorState.lineSeparator)));
