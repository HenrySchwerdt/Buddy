/**
 * Algorithm benchmark: runs every algorithm (plus open-loop pump therapy as baseline)
 * across the virtual cohort and scenarios and prints consensus metrics.
 *
 *   pnpm sim                         # everything
 *   pnpm sim --algo oref-smb         # one algorithm
 *   pnpm sim --scenario unannounced  # one scenario
 *   pnpm sim --json out.json         # machine-readable results
 */
import { writeFileSync } from 'node:fs';
import { BUILT_IN_ALGORITHMS } from '@buddy/algorithms';
import { COHORT, SCENARIOS, runSimulation } from './index';
const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
};
async function main() {
    const algos = BUILT_IN_ALGORITHMS.filter((a) => !arg('algo') || a.meta.id === arg('algo'));
    const scenarios = SCENARIOS.filter((s) => !arg('scenario') || s.id === arg('scenario'));
    const patients = COHORT.filter((p) => !arg('patient') || p.id === arg('patient'));
    const results = [];
    const runs = [{ label: 'open-loop', algo: BUILT_IN_ALGORITHMS[0], mode: 'open' }, ...algos.map((a) => ({ label: a.meta.id, algo: a, mode: 'closed' }))];
    for (const scenario of scenarios) {
        console.log(`\n▌ ${scenario.name} — ${scenario.description}`);
        console.log('  algorithm         TIR%   TBR<70  TBR<54  TAR>180  mean   CV%   LBGI  HBGI  insulin  auto');
        for (const r of runs) {
            const per = await Promise.all(patients.map((patient) => runSimulation({ algorithm: r.algo, patient, scenario, mode: r.mode })));
            results.push(...per.map((x) => ({ ...x, algorithmId: r.label })));
            const avg = (k) => per.reduce((s, x) => s + Number(x.metrics[k]), 0) / per.length;
            const f = (x, w, d = 1) => x.toFixed(d).padStart(w);
            console.log(`  ${r.label.padEnd(16)} ${f(avg('tir'), 5)} ${f(avg('tbr70'), 7)} ${f(avg('tbr54'), 7)} ${f(avg('tar180'), 8)} ${f(avg('mean'), 6, 0)} ${f(avg('cv'), 5)} ${f(avg('lbgi'), 6, 2)} ${f(avg('hbgi'), 5, 1)} ${f(avg('totalInsulin'), 8)} ${f(avg('autoBolusInsulin'), 5)}`);
        }
    }
    const out = arg('json');
    if (out) {
        writeFileSync(out, JSON.stringify(results.map(({ trace: _t, ...rest }) => rest), null, 2));
        console.log(`\nWrote ${out}`);
    }
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
