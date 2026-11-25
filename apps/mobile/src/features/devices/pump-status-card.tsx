import { SymbolView } from '@/trio/symbol';
import { StyleSheet, View } from 'react-native';
import type { PumpState } from '@buddy/core';
import { T, useTrioColors } from '@/trio';
import type { CatalogEntry } from './catalog';
import { DeviceIcon } from './device-icon';

/** Life gauge at the top right of the card: patch expiry when known, otherwise battery. */
export interface PumpLife {
  readonly title: string;
  readonly value: string;
  readonly unit: string;
  /** 0…1 */
  readonly progress: number;
}

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Shown above 50 U like Trio's pumps ("50+ U"). */
const reservoirText = (u: number | null) => (u == null ? '--' : u > 50 ? '50+' : u.toFixed(u < 10 ? 1 : 0));

/**
 * Status section of Trio's pump settings sheets (MockPumpManagerSettingsView `statusSection` +
 * `InsulinStatusView`): artwork, life gauge, insulin delivery and insulin remaining.
 */
export function PumpStatusCard({ entry, state, life, nowMs }: { entry: CatalogEntry; state: PumpState | null; life: PumpLife | null; nowMs: number }) {
  const c = useTrioColors();
  const temp = state?.tempBasal && state.tempBasal.startedAt + state.tempBasal.durationMin * 60_000 > nowMs ? state.tempBasal : null;
  const reservoir = state?.reservoirUnits ?? null;
  return (
    <View style={[styles.card, { backgroundColor: c.chart }]}>
      <View style={styles.top}>
        <DeviceIcon entry={entry} size={77} background="#F2F2F7" />
        {life ? (
          <View style={{ flex: 1, gap: 4 }}>
            <T style_="subheadline" secondary>
              {life.title}
            </T>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
              <T size={24} weight="800">
                {life.value}
              </T>
              <T size={15} secondary>
                {life.unit}
              </T>
            </View>
            <View style={[styles.track, { backgroundColor: c.fill }]}>
              <View style={[styles.bar, { backgroundColor: c.insulin, width: `${Math.round(Math.min(1, Math.max(0, life.progress)) * 100)}%` }]} />
            </View>
          </View>
        ) : (
          <T style_="title3" style={{ flex: 1 }}>
            {entry.name}
          </T>
        )}
      </View>
      <View style={[styles.divider, { backgroundColor: c.separator }]} />
      <View style={{ flexDirection: 'row' }}>
        <View style={{ flex: 1, gap: 8 }}>
          <T secondary>Insulin Delivery</T>
          {state == null ? (
            <Status icon="xmark.circle.fill" color={c.red} label={'No\nDelivery'} />
          ) : state.suspended ? (
            <Status icon="pause.circle.fill" color={c.orange} label={'Insulin\nSuspended'} />
          ) : (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={[styles.basalIcon, { backgroundColor: c.tabBar }]}>
                  <SymbolView name={temp ? 'arrow.up.right' : 'arrow.right'} size={22} tintColor="#000" weight="semibold" />
                </View>
                <T style_="callout" weight="800" style={{ flex: 1 }}>
                  {temp ? `Temp Basal\n${temp.rate} U/h` : 'Scheduled\nBasal'}
                </T>
              </View>
              <T style_="footnote" color={c.tabBar}>
                at {hhmm(state.lastSync)}
              </T>
            </>
          )}
        </View>
        <View style={[styles.vdivider, { backgroundColor: c.separator }]} />
        <View style={{ flex: 1, gap: 8, alignItems: 'flex-end' }}>
          <T secondary>Insulin Remaining</T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={[styles.reservoir, { borderColor: c.tabBar }]}>
              <View style={{ flex: 1 }} />
              <View style={{ height: `${reservoir == null ? 0 : Math.round(Math.min(1, reservoir / 50) * 100)}%`, backgroundColor: c.tabBar, borderRadius: 3 }} />
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}>
              <T size={28} weight="800">
                {reservoirText(reservoir)}
              </T>
              <T secondary>U</T>
            </View>
          </View>
          {state?.batteryPercent != null && life?.unit !== '%' ? (
            <T style_="footnote" color={c.tabBar}>
              Battery {Math.round(state.batteryPercent)} %
            </T>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function Status({ icon, color, label }: { icon: 'pause.circle.fill' | 'xmark.circle.fill'; color: string; label: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <SymbolView name={icon} size={34} tintColor={color} />
      <T size={14} weight="800">
        {label}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 26, borderCurve: 'continuous', padding: 20, gap: 12 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  track: { height: 8, borderRadius: 4, overflow: 'hidden', marginTop: 6 },
  bar: { height: 8, borderRadius: 4 },
  divider: { height: StyleSheet.hairlineWidth },
  vdivider: { width: StyleSheet.hairlineWidth, marginHorizontal: 12 },
  basalIcon: { width: 36, height: 36, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  reservoir: { width: 26, height: 38, borderWidth: 2.5, borderRadius: 6, padding: 2 },
});
