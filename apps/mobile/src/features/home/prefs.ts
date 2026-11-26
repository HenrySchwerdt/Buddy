import { useShallow } from 'zustand/react/shallow';
import { useTrioPrefs } from '@/features/settings/store';
import type { GlucoseColorScheme } from './glucose-color';

/** The display preferences (User Interface settings) that shape the Home screen. */
export interface HomePrefs {
  readonly low: number;
  readonly high: number;
  readonly scheme: GlucoseColorScheme;
  readonly xGrid: boolean;
  readonly yGrid: boolean;
  /** "Show Low and High Thresholds": dashed lines on the chart. */
  readonly thresholdLines: boolean;
  readonly forecastType: 'cone' | 'lines';
  readonly bolusThreshold: number;
  /** Trio's `showCobIobChart` (always on; no setting exposes it). */
  readonly showCobIob: boolean;
  readonly a1cUnit: 'percent' | 'mmolMol';
  readonly tirType: 'timeInTightRange' | 'timeInNormoglycemia';
  readonly statsFace: 'timeInRange' | 'distributionBar' | 'averages' | 'hidden';
  readonly statsRange: 'today' | 'day' | 'week' | 'month' | 'threeMonths';
  readonly quickPickEnabled: boolean;
}

export function useHomePrefs(): HomePrefs {
  return useTrioPrefs(
    useShallow((s) => ({
      low: s.low,
      high: s.high,
      scheme: s.glucoseColorScheme,
      xGrid: s.xGridLines,
      yGrid: s.yGridLines,
      thresholdLines: s.rulerMarks,
      forecastType: s.forecastDisplayType,
      bolusThreshold: s.bolusDisplayThreshold,
      showCobIob: true,
      a1cUnit: s.eA1cDisplayUnit,
      tirType: s.timeInRangeType,
      statsFace: s.homeStatsPanelFace,
      statsRange: s.homeStatsPanelRange,
      quickPickEnabled: s.enableQuickPickTreatments,
    })),
  );
}
