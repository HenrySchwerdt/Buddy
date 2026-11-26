import type { LogLine } from './log-buffer';

/**
 * Report a Problem: builds a plain-text report that the user sends themselves (mail or share
 * sheet). Nothing is uploaded by Buddy. Like Trio's log export, secrets are removed first.
 */
export const MAX_TITLE = 200;
export const MAX_DESCRIPTION = 20_000;
export const ISSUES_URL = 'https://github.com/HenrySchwerdt/Buddy/issues/new';

export interface ProblemContext {
  readonly appVersion: string;
  readonly build: string;
  readonly platform: string;
  readonly osVersion: string;
  readonly deviceModel: string;
  readonly algorithm: string;
  readonly loopMode: string;
  readonly pump: string;
  readonly cgm: string;
  readonly units: string;
  /** Last loop runs, newest last, already summarised (no glucose values). */
  readonly recentLoops: readonly string[];
}

export interface ProblemDraft {
  readonly title: string;
  readonly description: string;
  readonly attachLogs: boolean;
}

const REDACTIONS: readonly [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [removed]'],
  [/(token|secret|password|passcode|api[-_ ]?key|authorization|bearer)(["']?\s*[:=]\s*["']?)[^\s"',;}&]+/gi, '$1$2[removed]'],
  [/(serial(?:\s*number)?|sn|uid|pairing(?:\s*key)?)(["']?\s*[:=]\s*["']?)[A-Za-z0-9-]{4,}/gi, '$1$2[removed]'],
  [/https?:\/\/[^\s/@]+:[^\s/@]+@/g, 'https://[removed]@'],
  [/([?&](?:token|secret|key)=)[^&\s]+/gi, '$1[removed]'],
];

/** Removes tokens, passwords, serial numbers and credentials from free text. */
export function redact(text: string): string {
  return REDACTIONS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}

export function canSubmit(draft: ProblemDraft): boolean {
  const d = draft.description.trim();
  return d.length > 0 && [...draft.description].length <= MAX_DESCRIPTION;
}

const clip = (s: string, max: number) => [...s].slice(0, max).join('');

const time = (t: number) => new Date(t).toISOString().slice(11, 19);

export function formatLogs(lines: readonly LogLine[], limit = 300): string {
  return lines
    .slice(-limit)
    .map((l) => `${time(l.t)} ${l.level.toUpperCase().padEnd(5)} ${redact(l.text)}`)
    .join('\n');
}

export function contextBlock(c: ProblemContext): string {
  return [
    `Buddy ${c.appVersion} (${c.build})`,
    `${c.platform} ${c.osVersion}, ${c.deviceModel}`,
    `Algorithm: ${c.algorithm}, loop mode: ${c.loopMode}, units: ${c.units}`,
    `Pump: ${c.pump || 'none'}, CGM: ${c.cgm || 'none'}`,
    ...(c.recentLoops.length ? ['Recent loops:', ...c.recentLoops.map((l) => `  ${l}`)] : []),
  ].join('\n');
}

export function subjectFor(draft: ProblemDraft, appVersion: string): string {
  const title = clip(draft.title.trim(), MAX_TITLE);
  return title ? `Buddy ${appVersion}: ${title}` : `Buddy ${appVersion}: problem report`;
}

/** The full report. */
export function buildReport(draft: ProblemDraft, context: ProblemContext, logs: readonly LogLine[]): string {
  const parts = [clip(draft.description.trim(), MAX_DESCRIPTION), '', '--- Device and app ---', contextBlock(context)];
  if (draft.attachLogs) parts.push('', '--- Recent logs ---', formatLogs(logs) || '(no log lines captured yet)');
  return parts.join('\n');
}

/** Mail clients cut very long mailto bodies, so the mail version keeps only the log tail. */
export function buildMailBody(draft: ProblemDraft, context: ProblemContext, logs: readonly LogLine[]): string {
  const body = buildReport(draft, context, logs);
  if (body.length <= MAIL_BODY_LIMIT) return body;
  const logStart = body.indexOf('\n--- Recent logs ---');
  const head = logStart === -1 ? body : body.slice(0, logStart);
  const keep = Math.max(0, MAIL_BODY_LIMIT - head.length - 120);
  const tail = logStart === -1 ? '' : body.slice(logStart).slice(-keep);
  return `${head.slice(0, MAIL_BODY_LIMIT - 120)}${tail ? `\n--- Recent logs (cut, use Share for all) ---\n${tail}` : ''}`;
}

const MAIL_BODY_LIMIT = 6000;

export function mailtoUrl(subject: string, body: string, to = ''): string {
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
