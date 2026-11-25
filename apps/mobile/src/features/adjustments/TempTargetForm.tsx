import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import {
  computeAdjustedPercentage,
  computeEffectiveHBT,
  computeHalfBasalTarget,
  isAdjustSensEnabled,
  MAX_TT_TARGET,
  MIN_TT_TARGET,
  MINUTE,
  percentageDescription,
  tempTargetDraftError,
  tempTargetPresetError,
  TT_NORMAL_TARGET,
  ttSliderRange,
  type ActiveTempTarget,
  type TempTargetPreset,
} from '@buddy/core';
import { fmtTime } from '@/features/format';
import { now } from '@/runtime/runtime';
import { useSettings } from '@/runtime/settings-store';
import { CapsuleButton, PickerRow, Row, Section, SheetScreen, T, useTrioColors } from '@/trio';
import { adjustmentDefaults, saveEditedTempTarget, saveTempTargetPreset, startCustomTempTarget } from './actions';
import { ErrorHeader, HelpSheet, ListButton, NameRow } from './components/form-bits';
import { CompactDateTime, StepSlider } from './components/native';
import { durationRows, targetRows } from './components/pickers';
import { formatPercent } from './format';
import { TEMP_TARGET_HELP } from './help';

type Open = 'target' | 'duration' | null;
type SensType = 'standard' | 'slider';

const SENS_OPTIONS: readonly { value: SensType; label: string }[] = [
  { value: 'standard', label: 'Standard' },
  { value: 'slider', label: 'Custom' },
];

const SLIDER_STEP = 5;

export type TempTargetFormMode = { kind: 'add' } | { kind: 'editPreset'; preset: TempTargetPreset } | { kind: 'editActive'; tempTarget: ActiveTempTarget };

/** Trio's AddTempTargetForm / EditTempTargetForm as one sheet. */
export function TempTargetForm({ mode }: { mode: TempTargetFormMode }) {
  const c = useTrioColors();
  const units = useSettings((s) => s.units);
  const { behavior } = useMemo(() => adjustmentDefaults(), []);
  const settingHbt = behavior.halfBasalExerciseTarget;
  const source = mode.kind === 'add' ? null : mode.kind === 'editPreset' ? mode.preset : mode.tempTarget;
  const isEdit = mode.kind !== 'add';
  const t0 = useMemo(() => now(), []);

  const initialTarget = source?.target ?? TT_NORMAL_TARGET;
  const initialHbt = source?.halfBasalTarget ?? settingHbt;
  const [name, setName] = useState(source?.name ?? '');
  const [target, setTarget] = useState(initialTarget);
  const [durationMin, setDuration] = useState(source?.durationMin ?? 0);
  const [startAt, setStartAt] = useState(mode.kind === 'editActive' ? mode.tempTarget.startedAt : t0);
  const [hbt, setHbt] = useState(initialHbt);
  const [percentage, setPercentage] = useState(() => computeAdjustedPercentage(initialHbt, initialTarget, behavior.autosensMax));
  const [sensType, setSensType] = useState<SensType>(() => {
    if (source?.halfBasalTarget == null || source.halfBasalTarget === settingHbt) return 'standard';
    const autoAdjusted = computeEffectiveHBT(null, settingHbt, source.target, behavior.autosensMax) !== null;
    return autoAdjusted ? 'standard' : 'slider';
  });
  const [sliding, setSliding] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  const [help, setHelp] = useState(false);
  const [targetStep, setTargetStep] = useState(isEdit ? 1 : units === 'mg/dL' ? 5 : 9);
  const toggle = (which: Exclude<Open, null>) => setOpen((o) => (o === which ? null : which));

  const changeTarget = (t: number) => {
    setTarget(t);
    // Trio: with the setting's HBT keep it and recompute the %, otherwise keep the % and move the HBT.
    if (hbt === settingHbt) setPercentage(computeAdjustedPercentage(hbt, t, behavior.autosensMax));
    else setHbt(computeHalfBasalTarget(t, percentage));
  };
  const changeSensType = (v: SensType) => {
    setSensType(v);
    if (v === 'standard') {
      setHbt(settingHbt);
      setPercentage(computeAdjustedPercentage(settingHbt, target, behavior.autosensMax));
    }
  };

  const draft = { name: name.trim(), target, durationMin, halfBasalTarget: hbt };
  const ttError = tempTargetDraftError({ target, durationMin }, units);
  const presetError = tempTargetPresetError({ target, durationMin, startAt }, now(), units);
  const initialStart = mode.kind === 'editActive' ? mode.tempTarget.startedAt : t0;
  const hasChanges = name !== (source?.name ?? '') || target !== initialTarget || durationMin !== (source?.durationMin ?? 0) || startAt !== initialStart || hbt !== initialHbt;
  const showSens = target !== TT_NORMAL_TARGET && isAdjustSensEnabled(target, behavior);
  const range = ttSliderRange(target, behavior.autosensMax);
  const running = mode.kind === 'editActive' && mode.tempTarget.startedAt <= now();

  const close = () => router.back();
  const start = () => {
    startCustomTempTarget(draft, startAt);
    close();
  };
  const savePreset = () => {
    saveTempTargetPreset(draft);
    close();
  };
  const saveEdit = () => {
    if (mode.kind === 'editPreset') saveTempTargetPreset({ ...draft, name: draft.name || mode.preset.name, id: mode.preset.id });
    if (mode.kind === 'editActive') saveEditedTempTarget(mode.tempTarget, { ...draft, name: draft.name || mode.tempTarget.name }, startAt);
    close();
  };

  return (
    <SheetScreen
      title={isEdit ? 'Edit Temp Target' : 'Add Temp Target'}
      leading={<CapsuleButton label="Cancel" onPress={close} />}
      trailing={<CapsuleButton icon="questionmark.circle" color={c.tabBar} onPress={() => setHelp(true)} accessibilityLabel="Help" />}>
      <View style={{ gap: 10 }}>
        <Section>
          <NameRow value={name} onChange={setName} />
        </Section>

        <Section>
          {targetRows({ value: target, units, step: targetStep, min: MIN_TT_TARGET, max: MAX_TT_TARGET, open: open === 'target', onToggle: () => toggle('target'), onChange: changeTarget, onStep: setTargetStep })}
        </Section>

        {showSens ? (
          <Section footer={percentageDescription(percentage) ?? undefined}>
            <PickerRow label="Sensitivity Adjustment" value={sensType} options={SENS_OPTIONS} onChange={changeSensType} />
            <Row>
              <T style_="title3" weight="700" align="center" color={sliding ? c.orange : c.tabBar} style={{ flex: 1 }}>
                {`${formatPercent(percentage)} Insulin`}
              </T>
            </Row>
            {sensType === 'slider' ? (
              <Row>
                <StepSlider
                  value={Math.min(Math.max(percentage, range.low), range.high)}
                  min={range.low}
                  max={range.high}
                  step={SLIDER_STEP}
                  minLabel={formatPercent(range.low)}
                  maxLabel={formatPercent(range.high)}
                  onChange={setPercentage}
                  onEditingChanged={(editing) => {
                    setSliding(editing);
                    if (!editing) setHbt(computeHalfBasalTarget(target, percentage));
                  }}
                />
              </Row>
            ) : null}
          </Section>
        ) : null}

        {mode.kind !== 'editPreset' ? (
          <Section>
            <Row>
              <T style={{ flex: 1 }}>Start Time</T>
              <CompactDateTime value={startAt} min={Math.min(t0, startAt)} onChange={setStartAt} />
            </Row>
          </Section>
        ) : null}

        <Section>{durationRows({ minutes: durationMin, open: open === 'duration', onToggle: () => toggle('duration'), onChange: setDuration, dimWhenZero: true })}</Section>

        {running ? (
          <T secondary align="right" style={{ marginHorizontal: 20 }}>
            {`Until ${fmtTime(Math.max(now(), startAt + durationMin * MINUTE))}`}
          </T>
        ) : null}

        {isEdit ? (
          <ListButton label="Save" disabled={!hasChanges || ttError !== null} background={c.accent} onPress={saveEdit} />
        ) : (
          <>
            <ErrorHeader message={presetError} />
            <ListButton label="Start Temp Target" disabled={ttError !== null} background={c.accent} onPress={start} />
            <ListButton label="Save as Preset" disabled={presetError !== null} background={c.dark ? 'rgba(235,235,245,0.6)' : 'rgba(60,60,67,0.6)'} onPress={savePreset} />
          </>
        )}
      </View>
      <HelpSheet visible={help} onClose={() => setHelp(false)} sections={TEMP_TARGET_HELP} />
    </SheetScreen>
  );
}
