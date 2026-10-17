import { randomUUID } from "node:crypto";

interface Editor {
  getEditorText(): string;
  pasteToEditor(text: string): void;
  setEditorText(text: string): void;
}

/** Own only the text we inserted; never overwrite an independently edited draft. */
export function createTranscriptPreview(editor: Editor) {
  let original: string | undefined;
  let expected: string | undefined;
  let prefix = "";
  let suffix = "";
  let accepted = false;

  return {
    update(transcript: string): boolean {
      if (!transcript && original === undefined) return true;
      const text = transcript ? `${transcript} ` : "";
      if (original === undefined) {
        original = editor.getEditorText();
        // The public UI has no cursor getter. Insert a unique locator and
        // replace it synchronously, before Pi renders or yields to input. This
        // also handles repeated text where diffing would give the wrong range.
        const marker = `\uE000${randomUUID()}\uE001`;
        editor.pasteToEditor(marker);
        const located = editor.getEditorText();
        const offset = located.indexOf(marker);
        if (offset < 0) return false;
        prefix = located.slice(0, offset);
        suffix = located.slice(offset + marker.length);
        expected = prefix + text + suffix;
        editor.setEditorText(expected);
        return true;
      }
      if (editor.getEditorText() !== expected) return false;
      const next = prefix + text + suffix;
      if (next !== expected) editor.setEditorText(next);
      expected = next;
      return true;
    },
    accept() { accepted = true; },
    rollback() {
      if (!accepted && original !== undefined && expected !== undefined && editor.getEditorText() === expected) {
        editor.setEditorText(original);
      }
    },
  };
}
