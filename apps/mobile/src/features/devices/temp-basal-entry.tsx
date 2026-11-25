import { useState } from 'react';
import { Alert } from 'react-native';
import { HOUR } from '@buddy/core';
import { currentPump, now, store, useRuntime } from '@/runtime/runtime';
import { useSettings } from '@/runtime/settings-store';
import { InputRow, PickerRow, PrimaryButton, Section, T, useTrioColors, ValueRow } from '@/trio';

const DURATIONS = Array.from({ length: 24 }, (_, i) => (i + 1) * 30);

const fmtRate = (r: number) => `${r.toFixed(2)} U/h`;
const fmtDuration = (min: number) => `${(min / 60).toFixed(1)} hours`;

/** Validates a manual temp basal: 0 … max basal, on the pump's increment grid. */
export function parseTempRate(text: string, maxBasalRate: number, increment: number): { rate: number } | { error: string } {
  const n = Number(text.replace(',', '.'));
  if (text.trim() === '' || !Number.isFinite(n)) return { error: 'Enter a rate.' };
  if (n < 0 || n > maxBasalRate) return { error: `The rate must be between 0 and ${maxBasalRate} U/h (Max Basal Rate).` };
  const step = increment > 0 ? increment : 0.05;
  return { rate: Math.round(Math.round(n / step) * step * 1000) / 1000 };
}

/** Port of MockKitUI's `ManualTempBasalEntryView` ("Temporary Basal"). Open loop only. */
export function TempBasalEntry({ onDone }: { onDone: () => void }) {
  const c = useTrioColors();
  const maxBasalRate = useSettings((s) => s.limits.maxBasalRate);
  const increment = useRuntime((s) => s.pump?.basalIncrement ?? 0.05);
  const [rateText, setRateText] = useState('');
  const [duration, setDuration] = useState(30);
  const [busy, setBusy] = useState(false);
  const parsed = parseTempRate(rateText, maxBasalRate, increment);
  const rate = 'rate' in parsed ? parsed.rate : 0;

  const enact = async () => {
    const pump = currentPump();
    if (!pump || !('rate' in parsed)) return;
    setBusy(true);
    try {
      const r = await pump.setTempBasal(parsed.rate, duration);
      if (!r.ok) throw new Error(r.error);
      store.addDoses(await pump.history(now() - HOUR));
      useRuntime.setState({ pump: await pump.status() });
      onDone();
    } catch (e) {
      Alert.alert('Temporary Basal Failed', `Unable to set a temporary basal rate: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section footer="Your insulin delivery will not be automatically adjusted until the temporary basal rate finishes or is canceled.">
        <ValueRow label="Rate" value={`${fmtRate(rate)} for ${fmtDuration(duration)}`} />
        <InputRow label="Basal Rate" value={rateText} onChangeText={setRateText} unit="U/h" />
        <PickerRow label="Duration" value={duration} options={DURATIONS.map((d) => ({ value: d, label: fmtDuration(d) }))} onChange={setDuration} />
      </Section>
      {'error' in parsed && rateText.trim() !== '' ? (
        <T color={c.red} style={{ marginHorizontal: 20 }}>
          {parsed.error}
        </T>
      ) : null}
      <PrimaryButton label="Set Temporary Basal" disabled={!('rate' in parsed)} loading={busy} onPress={() => void enact()} />
    </>
  );
}
