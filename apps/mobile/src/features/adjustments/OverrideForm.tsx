import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import {
  disableSmbFlags,
  disableSmbModeOf,
  inverseChangeFlags,
  inverseChangeOf,
  MAX_TEMP_TARGET,
  MIN_TEMP_TARGET,
  overrideDraftError,
  percentageDescription,
  scheduleValueAt,
  type ActiveOverride,
  type DisableSmbMode,
  type InverseChange,
  type OverridePreset,
} from '@buddy/core';
import { now } from '@/runtime/runtime';
import { useSettings } from '@/runtime/settings-store';
import { CapsuleButton, PickerRow, Section, SheetScreen, ToggleRow, useTrioColors } from '@/trio';
import { adjustmentDefaults, saveOverridePreset, saveRunningOverride, startCustomOverride } from './actions';
import { ErrorHeader, HelpSheet, ListButton, NameRow, PairRow } from './components/form-bits';
import { HourRangeWheels, MinutesWheels, durationRows, percentageRows, targetRows } from './components/pickers';
import { formatHour } from './format';
import { OVERRIDE_HELP } from './help';

type Open = 'percentage' | 'target' | 'schedule' | 'minutes' | 'duration' | null;

const INVERSE_OPTIONS: readonly { value: InverseChange; label: string }[] = [
  { value: 'isfAndCr', label: 'ISF/CR' },
  { value: 'isf', label: 'ISF' },
  { value: 'cr', label: 'CR' },
  { value: 'none', label: 'None' },
];

const SMB_OPTIONS: readonly { value: DisableSmbMode; label: string }[] = [
  { value: 'dontDisable', label: "Don't Disable" },
  { value: 'disable', label: 'Disable' },
  { value: 'disableOnSchedule', label: 'Disable on Schedule' },
];

interface Draft {
  name: string;
  percentage: number;
  inverse: InverseChange;
  overrideTarget: boolean;
  target: number;
  smbMode: DisableSmbMode;
  start: number;
  end: number;
  overrideSmbMinutes: boolean;
  smbMinutes: number;
  uamMinutes: number;
  indefinite: boolean;
  durationMin: number;
}

export type OverrideFormMode = { kind: 'add' } | { kind: 'editPreset'; preset: OverridePreset } | { kind: 'editRunning'; override: ActiveOverride };

function draftFrom(p: OverridePreset | null, profileTarget: number, defaults: { smbMinutes: number; uamMinutes: number }): Draft {
  return {
    name: p?.name ?? '',
    percentage: p?.percentage ?? 100,
    inverse: p ? inverseChangeOf(p) : 'isfAndCr',
    overrideTarget: !!p?.target,
    target: p?.target || profileTarget || 100,
    smbMode: p ? disableSmbModeOf(p) : 'dontDisable',
    start: p?.smbOffStartHour ?? 0,
    end: p?.smbOffEndHour ?? 0,
    overrideSmbMinutes: !!p?.overrideSmbMinutes,
    smbMinutes: p?.smbMinutes ?? defaults.smbMinutes,
    uamMinutes: p?.uamMinutes ?? defaults.uamMinutes,
    indefinite: p ? p.durationMin === null : true,
    durationMin: p?.durationMin ?? 0,
  };
}

function toPreset(d: Draft): Omit<OverridePreset, 'id'> {
  const smb = disableSmbFlags(d.smbMode);
  return {
    name: d.name.trim(),
    percentage: d.percentage,
    ...inverseChangeFlags(d.inverse),
    target: d.overrideTarget ? d.target : null,
    disableSmb: smb.disableSmb,
    smbIsScheduledOff: smb.smbIsScheduledOff,
    ...(smb.smbIsScheduledOff ? { smbOffStartHour: d.start, smbOffEndHour: d.end } : {}),
    overrideSmbMinutes: d.overrideSmbMinutes && !smb.disableSmb,
    ...(d.overrideSmbMinutes && !smb.disableSmb ? { smbMinutes: d.smbMinutes, uamMinutes: d.uamMinutes } : {}),
    durationMin: d.indefinite ? null : d.durationMin,
  };
}

/** Trio's AddOverrideForm / EditOverrideForm as one sheet. */
export function OverrideForm({ mode }: { mode: OverrideFormMode }) {
  const c = useTrioColors();
  const s = useSettings();
  const defaults = useMemo(() => adjustmentDefaults(), []);
  const profileTarget = Math.round(scheduleValueAt(s.profile.target, now(), s.profile.utcOffsetMinutes).low);
  const source = mode.kind === 'add' ? null : mode.kind === 'editPreset' ? mode.preset : mode.override;
  const [initial] = useState(() => draftFrom(source, profileTarget, defaults));
  const [d, setD] = useState<Draft>(initial);
  const [open, setOpen] = useState<Open>(null);
  const [help, setHelp] = useState(false);
  const isEdit = mode.kind !== 'add';
  const [percentageStep, setPercentageStep] = useState(isEdit ? 1 : 5);
  const [targetStep, setTargetStep] = useState(isEdit ? 1 : s.units === 'mg/dL' ? 5 : 9);

  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const toggle = (which: Exclude<Open, null>) => setOpen((o) => (o === which ? null : which));
  const smb = disableSmbFlags(d.smbMode);
  const hasChanges = JSON.stringify(d) !== JSON.stringify(initial);
  const error = overrideDraftError(
    { percentage: d.percentage, indefinite: d.indefinite, durationMin: d.durationMin, overrideTarget: d.overrideTarget, target: d.target, overrideSmbMinutes: d.overrideSmbMinutes, ...smb },
    s.units,
  );
  const invalid = error !== null || (isEdit && !hasChanges);

  const close = () => router.back();
  const start = () => {
    startCustomOverride(toPreset(d));
    close();
  };
  const savePreset = () => {
    saveOverridePreset(toPreset(d));
    close();
  };
  const saveEdit = () => {
    if (mode.kind === 'editPreset') saveOverridePreset({ ...toPreset(d), name: d.name.trim() || mode.preset.name, id: mode.preset.id });
    if (mode.kind === 'editRunning') saveRunningOverride(mode.override, toPreset(d));
    close();
  };

  return (
    <SheetScreen
      title={isEdit ? 'Edit Override' : 'Add Override'}
      leading={<CapsuleButton label="Cancel" onPress={close} />}
      trailing={<CapsuleButton icon="questionmark.circle" color={c.tabBar} onPress={() => setHelp(true)} accessibilityLabel="Help" />}>
      <View style={{ gap: 10 }}>
        <Section>
          <NameRow value={d.name} onChange={(name) => set({ name })} placeholder={isEdit ? 'Name' : '(Optional)'} />
        </Section>

        <Section footer={percentageDescription(d.percentage) ?? undefined}>
          {percentageRows({ value: d.percentage, step: percentageStep, open: open === 'percentage', onToggle: () => toggle('percentage'), onChange: (percentage) => set({ percentage }), onStep: setPercentageStep })}
          <PickerRow label="Also Inversely Change" value={d.inverse} options={INVERSE_OPTIONS} onChange={(inverse) => set({ inverse })} />
        </Section>

        <Section>
          <ToggleRow label="Override Target" value={d.overrideTarget} onChange={(overrideTarget) => set({ overrideTarget, target: d.target || 100 })} />
          {d.overrideTarget
            ? targetRows({ value: d.target, units: s.units, step: targetStep, min: MIN_TEMP_TARGET, max: MAX_TEMP_TARGET, open: open === 'target', onToggle: () => toggle('target'), onChange: (target) => set({ target }), onStep: setTargetStep })
            : null}
        </Section>

        <Section>
          <PickerRow label="Disable SMBs" value={d.smbMode} options={SMB_OPTIONS} onChange={(smbMode) => set({ smbMode })} />
          {smb.smbIsScheduledOff ? <PairRow left={['From', formatHour(d.start)]} right={['To', formatHour(d.end)]} open={open === 'schedule'} onPress={() => toggle('schedule')} /> : null}
          {smb.smbIsScheduledOff && open === 'schedule' ? <HourRangeWheels start={d.start} end={d.end} onStart={(start) => set({ start })} onEnd={(end) => set({ end })} /> : null}
        </Section>

        {!smb.disableSmb ? (
          <Section>
            <ToggleRow label={isEdit ? 'Change Max SMB Minutes' : 'Override Max SMB Minutes'} value={d.overrideSmbMinutes} onChange={(overrideSmbMinutes) => set({ overrideSmbMinutes })} />
            {d.overrideSmbMinutes ? <PairRow left={['SMB', `${d.smbMinutes} min`]} right={['UAM', `${d.uamMinutes} min`]} open={open === 'minutes'} onPress={() => toggle('minutes')} /> : null}
            {d.overrideSmbMinutes && open === 'minutes' ? <MinutesWheels smb={d.smbMinutes} uam={d.uamMinutes} onSmb={(smbMinutes) => set({ smbMinutes })} onUam={(uamMinutes) => set({ uamMinutes })} /> : null}
          </Section>
        ) : null}

        <Section>
          <ToggleRow label="Enable Indefinitely" value={d.indefinite} onChange={(indefinite) => set({ indefinite })} />
          {!d.indefinite ? durationRows({ minutes: d.durationMin, open: open === 'duration', onToggle: () => toggle('duration'), onChange: (durationMin) => set({ durationMin }) }) : null}
        </Section>

        <ErrorHeader message={error} />
        {isEdit ? (
          <ListButton label="Save Override" disabled={invalid} background={c.accent} onPress={saveEdit} />
        ) : (
          <>
            <ListButton label="Start Override" disabled={invalid} background={c.accent} onPress={start} />
            <ListButton label="Save as Preset" disabled={invalid} background={c.dark ? 'rgba(235,235,245,0.6)' : 'rgba(60,60,67,0.6)'} onPress={savePreset} />
          </>
        )}
      </View>
      <HelpSheet visible={help} onClose={() => setHelp(false)} sections={OVERRIDE_HELP} />
    </SheetScreen>
  );
}
