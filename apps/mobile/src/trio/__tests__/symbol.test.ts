/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SF_SYMBOLS_WITH_ANDROID } from '../symbol-map';

const SRC = join(__dirname, '..', '..');
const SF_INDEX = readFileSync(join(SRC, '..', '..', '..', 'node_modules', 'sf-symbols-typescript', 'dist', 'index.d.ts'), 'utf8');
const SF_NAMES = new Set([...SF_INDEX.matchAll(/'([a-z0-9.]+)'/g)].map((m) => m[1]!));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry: string) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === '__tests__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

describe('Android symbol mapping', () => {
  it('maps every SF Symbol used in the app to a Material Symbol', () => {
    // Arrange: every quoted literal in the app that is a real multi-character SF Symbol name.
    const used = new Set<string>();
    for (const file of sourceFiles(SRC)) {
      if (/symbol(-map)?\.tsx?$/.test(file)) continue;
      for (const m of readFileSync(file, 'utf8').matchAll(/['"]([a-z0-9]+(?:\.[a-z0-9]+)+|[a-z]{3,})['"]/g)) {
        if (SF_NAMES.has(m[1]!)) used.add(m[1]!);
      }
    }
    const mapped = new Set(SF_SYMBOLS_WITH_ANDROID);

    // Act
    const missing = [...used].filter((name) => /^[a-z]/.test(name) && name.includes('.') && !mapped.has(name));

    // Assert
    expect(missing).toEqual([]);
  });
});
