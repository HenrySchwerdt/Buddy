import { describe, expect, it } from 'vitest';
import { appendLine, formatArgs, type LogLine } from '../log-buffer';
import { buildMailBody, buildReport, canSubmit, mailtoUrl, redact, subjectFor, type ProblemContext } from '../problem-report';

const ctx: ProblemContext = { appVersion: '0.1.0', build: '1', platform: 'ios', osVersion: '26.0', deviceModel: 'iPhone', algorithm: 'oref-smb', loopMode: 'open', pump: 'demo-pump', cgm: 'demo-cgm', units: 'mg/dL', recentLoops: ['12:00 ok'] };
const line = (text: string, t = 0): LogLine => ({ t, level: 'log', text });

describe('redact', () => {
  it('removes tokens, passwords, serial numbers and URL credentials', () => {
    expect(redact('token=abc123def')).toBe('token=[removed]');
    expect(redact('{"password": "hunter2"}')).not.toContain('hunter2');
    expect(redact('Authorization: Bearer abcdef123456')).not.toContain('abcdef123456');
    expect(redact('serial number: ABC12345')).not.toContain('ABC12345');
    expect(redact('https://user:pw@site.example/x')).toBe('https://[removed]@site.example/x');
    expect(redact('GET /api?token=zzz&x=1')).toBe('GET /api?token=[removed]&x=1');
  });
  it('keeps ordinary text', () => {
    expect(redact('loop finished in 120 ms')).toBe('loop finished in 120 ms');
  });
});

describe('canSubmit', () => {
  it('needs a non-blank description within the limit', () => {
    expect(canSubmit({ title: '', description: '  ', attachLogs: true })).toBe(false);
    expect(canSubmit({ title: '', description: 'x', attachLogs: true })).toBe(true);
    expect(canSubmit({ title: '', description: 'x'.repeat(20_001), attachLogs: true })).toBe(false);
  });
});

describe('buildReport', () => {
  it('includes description, context and redacted logs when attached', () => {
    const r = buildReport({ title: 't', description: 'It crashed', attachLogs: true }, ctx, [line('login token=secret1234')]);
    expect(r).toContain('It crashed');
    expect(r).toContain('Buddy 0.1.0 (1)');
    expect(r).toContain('token=[removed]');
    expect(r).not.toContain('secret1234');
  });
  it('omits logs when not attached', () => {
    expect(buildReport({ title: '', description: 'x', attachLogs: false }, ctx, [line('a')])).not.toContain('Recent logs');
  });
  it('shortens long mail bodies but keeps the description', () => {
    const logs = Array.from({ length: 400 }, (_, i) => line(`line ${i} ${'x'.repeat(40)}`));
    const body = buildMailBody({ title: '', description: 'It crashed', attachLogs: true }, ctx, logs);
    expect(body.length).toBeLessThanOrEqual(6200);
    expect(body).toContain('It crashed');
    expect(body).toContain('line 399');
  });
});

describe('mail helpers', () => {
  it('encodes the mailto url and builds subjects', () => {
    expect(mailtoUrl('a b', 'x&y')).toBe('mailto:?subject=a%20b&body=x%26y');
    expect(subjectFor({ title: ' Pump ', description: '', attachLogs: true }, '0.1.0')).toBe('Buddy 0.1.0: Pump');
    expect(subjectFor({ title: '', description: '', attachLogs: true }, '0.1.0')).toBe('Buddy 0.1.0: problem report');
  });
});

describe('log buffer', () => {
  it('bounds the ring to 500 lines, dropping the oldest', () => {
    let b: LogLine[] = [];
    for (let i = 0; i < 520; i++) b = appendLine(b, line(String(i), i));
    expect(b).toHaveLength(500);
    expect(b[0]!.text).toBe('20');
  });
  it('formats mixed arguments', () => {
    expect(formatArgs(['a', 1, { b: 2 }])).toBe('a 1 {"b":2}');
  });
});
