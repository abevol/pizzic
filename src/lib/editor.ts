import {
  Decoration,
  EditorView,
  WidgetType,
  drawSelection,
  dropCursor,
  highlightSpecialChars,
  keymap,
  type DecorationSet,
} from "@codemirror/view";
import { Compartment, EditorState, StateField, type Extension, type Range } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { moduleHue, moduleLabel, parseDoc, type ModuleSeg } from "./document";

const mdHighlight = HighlightStyle.define([
  { tag: t.heading, color: "#F2F4FA", fontWeight: "600" },
  { tag: t.strong, color: "#ECEEF7", fontWeight: "650" },
  { tag: t.emphasis, color: "#D9DDE8", fontStyle: "italic" },
  { tag: t.strikethrough, color: "#69718A", textDecoration: "line-through" },
  { tag: t.link, color: "#A78BFA" },
  { tag: t.url, color: "#7DD3FC" },
  { tag: t.monospace, color: "#5EEAD4" },
  { tag: t.quote, color: "#8A91A6", fontStyle: "italic" },
  { tag: t.list, color: "#78809A" },
  { tag: t.meta, color: "#69718A" },
  { tag: t.processingInstruction, color: "#69718A" },
  { tag: t.contentSeparator, color: "#4E5670" },
]);

const editorTheme = EditorView.theme(
  {
    "&": { backgroundColor: "transparent", color: "#C9CEDA", height: "100%" },
    ".cm-scroller": {
      fontFamily: "'Geist Mono', ui-monospace, 'Cascadia Mono', Consolas, monospace",
      fontSize: "13px",
      lineHeight: "1.85",
      padding: "16px 22px 140px",
    },
    ".cm-content": { caretColor: "#C4B5FD", userSelect: "text" },
    ".cm-line": { padding: "0 8px", borderRadius: "8px" },
    ".cm-cursor, .cm-dropCursor": { borderLeft: "2px solid #C4B5FD" },
    ".cm-selectionBackground": {
      backgroundColor: "rgba(167,139,250,0.15) !important",
      borderRadius: "4px",
    },
    ".cm-focused .cm-selectionBackground": { backgroundColor: "rgba(167,139,250,0.24) !important" },
    ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.02)" },
    ".cm-selectionMatch": { backgroundColor: "rgba(94,234,212,0.13)" },
    ".cm-searchMatch": {
      backgroundColor: "rgba(252,211,77,0.16)",
      outline: "1px solid rgba(252,211,77,0.3)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgba(252,211,77,0.3)" },
    ".cm-panels": {
      backgroundColor: "rgba(13,15,21,0.96)",
      color: "#C9CEDA",
      borderBottom: "1px solid rgba(255,255,255,0.07)",
    },
    ".cm-panel.cm-search": { padding: "8px 12px", display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" },
    ".cm-panel.cm-search label": { color: "#8A91A6", fontSize: "12px" },
    ".cm-textfield": {
      background: "rgba(255,255,255,0.05)",
      border: "1px solid rgba(255,255,255,0.1)",
      borderRadius: "8px",
      color: "#E7EAF2",
      padding: "4px 10px",
      outline: "none",
      fontFamily: "'Geist Mono', monospace",
      fontSize: "12px",
    },
    ".cm-textfield::placeholder": { color: "#5D6478" },
    ".cm-button": {
      background: "rgba(255,255,255,0.06)",
      border: "1px solid rgba(255,255,255,0.09)",
      color: "#C9CEDA",
      borderRadius: "999px",
      padding: "4px 14px",
      cursor: "pointer",
      fontSize: "12px",
      transition: "all .3s cubic-bezier(.32,.72,0,1)",
    },
    ".cm-button:hover": { background: "rgba(255,255,255,0.12)" },
    ".cm-tooltip": {
      background: "rgba(16,18,26,0.97)",
      border: "1px solid rgba(255,255,255,0.09)",
      borderRadius: "10px",
      overflow: "hidden",
    },
  },
  { dark: true },
);

class DisabledChip extends WidgetType {
  constructor(readonly mod: ModuleSeg) {
    super();
  }

  eq(other: DisabledChip) {
    return other.mod.name === this.mod.name;
  }

  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "pz-off-row";
    const chip = document.createElement("span");
    chip.className = "pz-off-chip";
    const label = moduleLabel(this.mod);
    chip.textContent =
      label === this.mod.name ? `已停用 · ${this.mod.name}` : `已停用 · ${label}（${this.mod.name}）`;
    wrap.appendChild(chip);
    return wrap;
  }

  ignoreEvent() {
    return false;
  }
}

/** 每次文档变化后全量重扫（指令文件都是小文件，解析成本可忽略）。 */
function buildModuleDecorations(state: EditorState): DecorationSet {
  const doc = state.doc;
  const { modules } = parseDoc(doc.toString());
  const parts: Range<Decoration>[] = [];

  for (const m of modules) {
    const hue = moduleHue(m.name);
    parts.push({
      from: m.beginStart,
      to: m.beginEnd,
      value: Decoration.mark({ class: m.enabled ? "pz-tag" : "pz-tag pz-tag-off" }),
    });
    if (m.endEnd > m.endStart) {
      parts.push({
        from: m.endStart,
        to: m.endEnd,
        value: Decoration.mark({ class: "pz-tag" }),
      });
    }

    const headLine = doc.lineAt(m.beginStart);
    parts.push({
      from: headLine.from,
      to: headLine.from,
      value: Decoration.line({ class: `pz-mod-head pz-hue-${hue}` }),
    });
    if (m.endStart > m.beginEnd) {
      const tailLine = doc.lineAt(m.endStart);
      parts.push({
        from: tailLine.from,
        to: tailLine.from,
        value: Decoration.line({ class: `pz-mod-tail pz-hue-${hue}` }),
      });
    }

    if (m.body.trim() !== "") {
      const first = doc.lineAt(m.bodyStart).number;
      const last = doc.lineAt(m.bodyEnd - 1).number;
      for (let n = first; n <= last; n++) {
        const line = doc.line(n);
        parts.push({
          from: line.from,
          to: line.from,
          value: Decoration.line({ class: `pz-mod-body pz-hue-${hue}` }),
        });
      }
    }

    if (!m.enabled) {
      const closed = m.endStart > m.beginEnd;
      parts.push({
        from: closed ? m.endStart : doc.length,
        to: closed ? m.endStart : doc.length,
        value: Decoration.widget({
          widget: new DisabledChip(m),
          side: closed ? -1 : 1,
          block: true,
        }),
      });
    }
  }

  parts.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(parts, true);
}

/**
 * 模块装饰必须由 StateField 提供：CodeMirror 禁止 ViewPlugin 提供 block
 * decorations（block widget 影响布局测量，需要随事务映射），否则在出现停用
 * 占位块时抛 "Block decorations may not be specified via plugins"。
 */
const moduleDecorations = StateField.define<DecorationSet>({
  create: (state) => buildModuleDecorations(state),
  update: (value, tr) => (tr.docChanged ? buildModuleDecorations(tr.state) : value),
  provide: (f) => EditorView.decorations.from(f),
});

export interface EditorHooks {
  onDocChanged(): void;
  onSelectionChange(empty: boolean): void;
  onSave(): void;
}

/** 只读由 Compartment 动态切换：符号链接视图的只读态不是静态配置。 */
const readOnlyCompartments = new WeakMap<EditorView, Compartment>();

function readOnlyExtensions(on: boolean): Extension {
  return [EditorState.readOnly.of(on), EditorView.editable.of(!on)];
}

export function setReadOnly(view: EditorView, on: boolean) {
  const compartment = readOnlyCompartments.get(view);
  if (!compartment) return;
  view.dispatch({ effects: compartment.reconfigure(readOnlyExtensions(on)) });
}

export function createEditor(host: HTMLElement, hooks: EditorHooks): EditorView {
  const readOnly = new Compartment();
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: "",
      extensions: [
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorView.lineWrapping,
        readOnly.of(readOnlyExtensions(false)),
        markdown(),
        syntaxHighlighting(mdHighlight),
        moduleDecorations,
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              hooks.onSave();
              return true;
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) hooks.onDocChanged();
          if (u.selectionSet) hooks.onSelectionChange(u.state.selection.main.empty);
        }),
        editorTheme,
      ],
    }),
  });
  readOnlyCompartments.set(view, readOnly);
  return view;
}

export function replaceDoc(view: EditorView, text: string) {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}
