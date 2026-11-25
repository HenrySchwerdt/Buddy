import { roundOverridePercentageToStep, roundTargetToStep, targetPickerValues, type GlucoseUnit } from '@buddy/core';
import { StyleSheet, View } from 'react-native';
import { formatGlucoseWithUnits, formatHour, formatPercent, formatSpan } from '../format';
import { RadioStep, TapValueRow } from './form-bits';
import { Wheel, WheelRow } from './native';

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const FIVE_MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);

/** Percentage row + (when open) step radios 1 % / 5 % and a 40–150 % wheel. */
export function percentageRows({ value, step, open, onToggle, onChange, onStep }: { value: number; step: number; open: boolean; onToggle: () => void; onChange: (v: number) => void; onStep: (s: number) => void }) {
  const options = [];
  for (let p = 40; p <= 150; p += step) options.push({ value: p, label: formatPercent(p) });
  const selected = Math.max(10, Math.min(Math.floor(value / step) * step, 200));
  return [
    <TapValueRow key="row" label="Basal Rate Adjustment" value={formatPercent(value)} open={open} onPress={onToggle} />,
    open ? (
      <WheelRow key="wheel">
        <View style={styles.radios}>
          {[1, 5].map((s) => (
            <RadioStep
              key={s}
              label={`${s} %`}
              selected={step === s}
              onPress={() => {
                onStep(s);
                onChange(roundOverridePercentageToStep(value, s));
              }}
            />
          ))}
        </View>
        <Wheel label="Basal Rate Adjustment" value={selected} options={options} onChange={onChange} />
      </WheelRow>
    ) : null,
  ];
}

/** Trio `TargetPicker`: value row + step radios (1/5 mg/dL, 0.1/0.5 mmol/L) + wheel. */
export function targetRows({ label = 'Target Glucose', value, units, step, min, max, open, onToggle, onChange, onStep }: { label?: string; value: number; units: GlucoseUnit; step: number; min: number; max: number; open: boolean; onToggle: () => void; onChange: (v: number) => void; onStep: (s: number) => void }) {
  const steps = units === 'mg/dL' ? [1, 5] : [1, 9];
  const options = targetPickerValues(min, max, step).map((v) => ({ value: v, label: formatGlucoseWithUnits(v, units) }));
  return [
    <TapValueRow key="row" label={label} value={formatGlucoseWithUnits(value, units)} open={open} onPress={onToggle} />,
    open ? (
      <WheelRow key="wheel">
        <View style={styles.radios}>
          {steps.map((s) => (
            <RadioStep
              key={s}
              label={formatGlucoseWithUnits(s, units)}
              selected={step === s}
              onPress={() => {
                onStep(s);
                onChange(roundTargetToStep(value, s));
              }}
            />
          ))}
        </View>
        <Wheel label={label} value={roundTargetToStep(value, step)} options={options} onChange={onChange} />
      </WheelRow>
    ) : null,
  ];
}

/** "Duration  1 hr 30 min" + hours (0–23 hr) and minutes (0–55 min) wheels. */
export function durationRows({ minutes, open, onToggle, onChange, dimWhenZero }: { minutes: number; open: boolean; onToggle: () => void; onChange: (m: number) => void; dimWhenZero?: boolean }) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [
    <TapValueRow key="row" label="Duration" value={formatSpan(minutes)} open={open} onPress={onToggle} dim={dimWhenZero && minutes === 0} />,
    open ? (
      <WheelRow key="wheel">
        <Wheel label="Hours" value={h} options={HOURS.map((x) => ({ value: x, label: `${x} hr` }))} onChange={(x) => onChange(x * 60 + m)} />
        <Wheel label="Minutes" value={m - (m % 5)} options={FIVE_MINUTES.map((x) => ({ value: x, label: `${x} min` }))} onChange={(x) => onChange(h * 60 + x)} />
      </WheelRow>
    ) : null,
  ];
}

/** From / To hour wheels of "Disable on Schedule". */
export function HourRangeWheels({ start, end, onStart, onEnd }: { start: number; end: number; onStart: (h: number) => void; onEnd: (h: number) => void }) {
  const options = HOURS.map((h) => ({ value: h, label: formatHour(h) }));
  return (
    <WheelRow>
      <Wheel label="From" value={start} options={options} onChange={onStart} />
      <Wheel label="To" value={end} options={options} onChange={onEnd} />
    </WheelRow>
  );
}

/** SMB / UAM minute wheels (0–180 min in 5 min steps). */
export function MinutesWheels({ smb, uam, onSmb, onUam }: { smb: number; uam: number; onSmb: (m: number) => void; onUam: (m: number) => void }) {
  const options = Array.from({ length: 37 }, (_, i) => ({ value: i * 5, label: `${i * 5} min` }));
  return (
    <WheelRow>
      <Wheel label="SMB" value={smb - (smb % 5)} options={options} onChange={onSmb} />
      <Wheel label="UAM" value={uam - (uam % 5)} options={options} onChange={onUam} />
    </WheelRow>
  );
}

const styles = StyleSheet.create({
  radios: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
