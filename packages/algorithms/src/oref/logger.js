/**
 * oref writes its reasoning to console.log/console.error. The vendored files import this
 * object instead of the global console so each run's output is captured and surfaced in
 * the app's algorithm log rather than spamming the device console.
 */
const lines = [];
const MAX_LINES = 400;
const push = (...args) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    if (lines.length > MAX_LINES)
        lines.shift();
};
export const orefConsole = { log: push, error: push, warn: push, info: push, debug: push };
/** Returns and clears the captured log of the last run. */
export function drainOrefLog() {
    return lines.splice(0, lines.length);
}
