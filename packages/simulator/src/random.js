/** Deterministic PRNG (mulberry32) so simulations are reproducible. */
export function createRng(seed) {
    let a = seed >>> 0;
    const next = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const gaussian = () => {
        const u = Math.max(1e-12, next());
        const v = next();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    return { next, gaussian, range: (lo, hi) => lo + (hi - lo) * next() };
}
