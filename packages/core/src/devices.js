export const systemClock = { now: () => Date.now() };
export const silentLogger = { info: () => { }, warn: () => { }, error: () => { } };
export const definePump = (p) => p;
export const defineCgm = (p) => p;
