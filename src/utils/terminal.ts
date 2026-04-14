import { Terminal as XtermTerminal } from "@xterm/xterm";

// Capture scrollback from terminal buffer (up to 5000 lines)
export function captureScrollback(term: XtermTerminal): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  const maxLines = 5000;
  const totalLines = buffer.length;
  const startLine = Math.max(0, totalLines - maxLines);

  for (let y = startLine; y < totalLines; y++) {
    const line = buffer.getLine(y);
    if (line) {
      lines.push(line.translateToString(true));
    }
  }

  return lines.join("\n");
}

export function getLastLinesFromBuffer(term: XtermTerminal, lineCount: number): string[] {
  const buffer = term.buffer.active;
  const totalLines = buffer.length;
  const lines: string[] = [];

  for (let y = totalLines - 1; y >= 0 && lines.length < lineCount; y -= 1) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true).replace(/\s+$/, "");
    if (text.length === 0) continue;
    lines.push(text);
  }

  return lines.reverse();
}
