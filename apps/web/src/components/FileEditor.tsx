import { useEffect, useRef, type KeyboardEvent } from 'react';
import { basicSetup } from 'codemirror';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState, Prec } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

function langFor(fileName: string) {
  const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'ts': case 'tsx': case 'js': case 'jsx': case 'mjs': case 'cjs':
    case 'json': case 'jsonc': case 'json5':
      return javascript();
    case 'py': case 'pyi':
      return python();
    case 'md': case 'markdown': case 'mdx':
      return markdown();
    default:
      return undefined;
  }
}

const tierwynHighlight = HighlightStyle.define([
  { tag: t.comment, color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: t.lineComment, color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: t.blockComment, color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: t.keyword, color: 'var(--syntax-keyword)' },
  { tag: t.controlKeyword, color: 'var(--syntax-keyword)' },
  { tag: t.definitionKeyword, color: 'var(--syntax-keyword)' },
  { tag: t.string, color: 'var(--syntax-string)' },
  { tag: t.number, color: 'var(--syntax-number)' },
  { tag: t.bool, color: 'var(--syntax-number)' },
  { tag: t.function(t.variableName), color: 'var(--syntax-function)', fontWeight: '600' },
  { tag: t.className, color: 'var(--syntax-class)' },
  { tag: t.typeName, color: 'var(--syntax-class)' },
  { tag: t.tagName, color: 'var(--syntax-tag)' },
  { tag: t.attributeName, color: 'var(--syntax-attr)' },
  { tag: t.propertyName, color: 'var(--syntax-attr)' },
  { tag: t.variableName, color: 'var(--syntax-text)' },
  { tag: t.standard(t.name), color: 'var(--syntax-builtin)' },
  { tag: t.meta, color: 'var(--syntax-meta)' },
  { tag: t.heading, color: 'var(--syntax-keyword)', fontWeight: '700' },
  { tag: t.url, color: 'var(--syntax-string)' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.operator, color: 'var(--syntax-keyword)' },
]);

const tierwynTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'transparent',
    color: 'var(--syntax-text)',
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'var(--mono, monospace)',
    fontSize: '13px',
    lineHeight: '1.55',
  },
  '.cm-content': {
    caretColor: 'var(--accent)',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: 'var(--text-3)',
  },
  '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.04)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'rgba(99, 102, 241, 0.35)',
  },
}, { dark: true });

export function FileEditor({ value, fileName, onSaveShortcut, onChange }: {
  value: string;
  fileName: string;
  onSaveShortcut: () => void;
  onChange: (v: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSaveShortcut);
  onChangeRef.current = onChange;
  onSaveRef.current = onSaveShortcut;

  useEffect(() => {
    if (!host.current) return;
    const lang = langFor(fileName);
    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        lang ?? [],
        syntaxHighlighting(tierwynHighlight),
        tierwynTheme,
        EditorView.contentAttributes.of({
          autocapitalize: 'off',
          autocorrect: 'off',
          spellcheck: 'false',
        }),
        Prec.highest(keymap.of([{
          key: 'Mod-s',
          run: () => {
            onSaveRef.current();
            return true;
          },
        }])),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // Create once per fileName — recreating on every keystroke drops the cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileName]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    if (v.state.doc.toString() !== value) {
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: value },
      });
    }
  }, [value]);

  const onKeyDown = (e: KeyboardEvent) => {
    // CM6's Mod-s keymap preventDefaults but doesn't stop propagation, so
    // when the editor has focus this fallback must not fire a second time.
    if (view.current?.hasFocus) return;
    if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      onSaveShortcut();
    }
  };

  return <div ref={host} className="file-modal-editor" onKeyDown={onKeyDown} />;
}
