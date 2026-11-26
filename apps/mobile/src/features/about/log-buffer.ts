/** In-memory ring buffer of recent console output, kept only on the device for Report a Problem. */
const MAX_LINES = 500;
const MAX_LINE_LENGTH = 600;

export interface LogLine {
  readonly t: number;
  readonly level: 'log' | 'info' | 'warn' | 'error';
  readonly text: string;
}

let lines: readonly LogLine[] = [];
let installed = false;

/** Returns a new buffer with `line` appended, bounded to MAX_LINES. */
export function appendLine(buffer: readonly LogLine[], line: LogLine): LogLine[] {
  const next = buffer.length >= MAX_LINES ? buffer.slice(buffer.length - MAX_LINES + 1) : buffer;
  return [...next, line];
}

export function formatArgs(args: readonly unknown[]): string {
  const text = args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack ?? a.message;
      try {
        return JSON.stringify(a) ?? String(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
  return text.length > MAX_LINE_LENGTH ? `${text.slice(0, MAX_LINE_LENGTH)}…` : text;
}

/** Starts capturing console output (idempotent). Output still reaches the original console. */
export function installLogCapture(): void {
  if (installed) return;
  installed = true;
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      lines = appendLine(lines, { t: Date.now(), level, text: formatArgs(args) });
      original(...args);
    };
  }
}

export const recentLogLines = (): readonly LogLine[] => lines;
