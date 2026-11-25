import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import determineBasal from '../src/oref/engine/determine-basal';
import tempBasalFunctions from '../src/oref/engine/basal-set-temp';
const goldens = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/oref-goldens.json.gz', import.meta.url))).toString());
describe('oref TypeScript port', () => {
    it('has a meaningful fixture', () => {
        expect(goldens.length).toBeGreaterThan(300);
        expect(goldens.filter((g) => g.result.units).length).toBeGreaterThan(100);
    });
    it('reproduces every recorded determine-basal result exactly', () => {
        const mismatches = [];
        goldens.forEach((g, i) => {
            const a = structuredClone(g.args);
            const actual = JSON.parse(JSON.stringify(call(...a)));
            if (JSON.stringify(actual) !== JSON.stringify(g.result))
                mismatches.push(`case ${i}: ${JSON.stringify(g.result).slice(0, 120)} ≠ ${JSON.stringify(actual).slice(0, 120)}`);
        });
        expect(mismatches.slice(0, 5)).toEqual([]);
    });
});
function call(...a) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const args = a;
    return determineBasal(args[0], args[1], args[2], args[3], args[4], args[5], tempBasalFunctions, args[6], args[7], args[8], args[9], args[10], args[11], args[12], args[13]);
}
