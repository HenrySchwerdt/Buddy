import { Platform } from 'react-native';
import { formatDelta, formatGlucose, type GlucoseUnit } from '@buddy/core';

export const fmtG = (mgdl: number | null | undefined, unit: GlucoseUnit) => (mgdl == null || !Number.isFinite(mgdl) ? '–' : formatGlucose(mgdl, unit));
export const fmtDelta = (mgdl: number | null | undefined, unit: GlucoseUnit) => (mgdl == null ? '' : formatDelta(mgdl, unit));
export const fmtU = (u: number | null | undefined, digits = 2) => (u == null ? '–' : u.toFixed(digits));
export const fmtTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const fmtAgo = (minutes: number | null) => (minutes === null ? 'no data' : minutes < 1 ? 'just now' : `${minutes} min ago`);

/** Height of the native tab bar (content scrolls underneath it). */
/** Extra offset above the native tab bar. On iOS the safe-area inset already includes the tab bar. */
export const TAB_BAR_HEIGHT = Platform.select({ ios: 0, android: 80, default: 60 });
