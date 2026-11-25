import type { GlucoseUnit } from '@buddy/core';
import { useEffect } from 'react';
import { View } from 'react-native';
import type { AlgorithmSubstep, DeliverySubstep } from '../model';
import { PICKERS, fmtNumber, fmtPercent, glucoseValue, glucoseWithUnits, pickerValues, pumpModel, type OnboardingDraft, type PickerSetting } from '../logic';
import { useOnboardingDraft } from '../store';
import { DELIVERY_TITLES, algorithmDescription, algorithmHint, algorithmTitle, deliveryDescription } from '../texts';
import { OT } from '../theme';
import { Bullet, Card, DescriptionBlocks, NoticeBox, Stack, StepHeading, ToggleCard, ValuePickerCard } from '../ui';

type NumberField = { [K in keyof OnboardingDraft]: OnboardingDraft[K] extends number ? K : never }[keyof OnboardingDraft];
type BoolField = { [K in keyof OnboardingDraft]: OnboardingDraft[K] extends boolean ? K : never }[keyof OnboardingDraft];

function SubstepHeader({ title, hint }: { title: string; hint: string }) {
  return (
    <>
      <StepHeading>{title}</StepHeading>
      <OT style_="subheadline" secondary style={{ paddingHorizontal: 16 }}>
        {hint}
      </OT>
    </>
  );
}

function DecimalSetting({ label, field, picker, format, units, disabled }: { label: string; field: NumberField; picker: PickerSetting; format: (v: number) => string; units: GlucoseUnit; disabled?: boolean }) {
  const value = useOnboardingDraft((s) => s[field]);
  const set = useOnboardingDraft((s) => s.set);
  return <ValuePickerCard label={label} value={value} options={pickerValues(picker, units)} format={format} onChange={(v) => set({ [field]: v })} disabled={disabled} />;
}

function BoolSetting({ label, field, disabled }: { label: string; field: BoolField; disabled?: boolean }) {
  const value = useOnboardingDraft((s) => s[field]);
  const set = useOnboardingDraft((s) => s.set);
  return <ToggleCard label={label} value={value} onChange={(v) => set({ [field]: v })} disabled={disabled} />;
}

const DELIVERY_FIELDS: Record<DeliverySubstep, { field: NumberField; picker: PickerSetting; unit?: string }> = {
  maxIOB: { field: 'maxIOB', picker: PICKERS.maxIOB, unit: 'U' },
  maxBolus: { field: 'maxBolus', picker: PICKERS.maxBolus, unit: 'U' },
  maxBasal: { field: 'maxBasal', picker: PICKERS.maxBasal, unit: 'U/hr' },
  maxCOB: { field: 'maxCOB', picker: PICKERS.maxCOB, unit: 'g' },
  minimumSafetyThreshold: { field: 'minimumSafetyThreshold', picker: PICKERS.thresholdSetting },
};

export function DeliveryLimitsStep({ substep }: { substep: DeliverySubstep }) {
  const units = useOnboardingDraft((s) => s.units);
  const seedMaxIOB = useOnboardingDraft((s) => s.seedMaxIOB);
  useEffect(() => {
    if (substep === 'maxIOB') seedMaxIOB();
  }, [substep, seedMaxIOB]);
  const { title, hint } = DELIVERY_TITLES[substep];
  const cfg = DELIVERY_FIELDS[substep];
  const format = (v: number) => (cfg.unit ? `${fmtNumber(v)} ${cfg.unit}` : glucoseWithUnits(v, units));
  return (
    <Stack gap={16}>
      <SubstepHeader title={title} hint={hint} />
      <DecimalSetting key={substep} label={title} field={cfg.field} picker={cfg.picker} format={format} units={units} />
      <DescriptionBlocks blocks={deliveryDescription(substep, (v) => glucoseValue(v, units), units)} />
    </Stack>
  );
}

export function AlgorithmContentsStep() {
  return (
    <Stack>
      <StepHeading>Configure the algorithm…</StepHeading>
      <NoticeBox>
        <OT>
          Our strong recommendation is to <OT weight="700">leave everything on default</OT> as a beginner.
        </OT>
      </NoticeBox>
      <Card style={{ gap: 20 }}>
        <OT>Buddy can automatically adapt insulin delivery based on inputs and glucose forecasts. Your algorithm settings play a major part in accurate and effective dosing.</OT>
        <View style={{ gap: 10 }}>
          <OT style_="headline" style={{ paddingBottom: 4 }}>
            In the next few steps, you’ll configure your algorithm settings for
          </OT>
          <Bullet text="Autosens" />
          <Bullet text="Super Micro Bolus (SMB)" />
          <Bullet text="Target Behavior" />
        </View>
        <OT>Only adjust these settings if you’re an advanced or returning user who knows what they’re doing.</OT>
      </Card>
    </Stack>
  );
}

export function AlgorithmImportantNotesStep() {
  return (
    <Stack>
      <StepHeading>A few important notes…</StepHeading>
      <NoticeBox>
        <OT>
          Dynamic ISF requires at least <OT weight="700">7 days</OT> of usage data and is not yet configurable.
        </OT>
      </NoticeBox>
      <Card style={{ gap: 10 }}>
        <OT style_="headline" style={{ paddingBottom: 4 }}>
          Some helpful reminders:
        </OT>
        <Bullet text="Even if you’re an updating user, you’ll be guided through the algorithm settings configuration step-by-step." />
        <Bullet text={'All additional "advanced settings" have been reset.'} />
        <Bullet text="The duration of insulin action (DIA) is now locked to Buddy’s new default of 10 hours." />
        <Bullet text="We strongly recommend not changing DIA — it’s essential to stable and safe operation." />
      </Card>
    </Stack>
  );
}

type AlgorithmInput = { kind: 'bool'; field: BoolField; dependsOnSMBAlways?: boolean } | { kind: 'decimal'; field: NumberField; picker: PickerSetting; format: 'percent' | 'glucose' | 'minutes' };

const ALGORITHM_INPUTS: Record<AlgorithmSubstep, AlgorithmInput> = {
  autosensMin: { kind: 'decimal', field: 'autosensMin', picker: PICKERS.autosensMin, format: 'percent' },
  autosensMax: { kind: 'decimal', field: 'autosensMax', picker: PICKERS.autosensMax, format: 'percent' },
  rewindResetsAutosens: { kind: 'bool', field: 'rewindResetsAutosens' },
  enableSMBAlways: { kind: 'bool', field: 'enableSMBAlways' },
  enableSMBWithCOB: { kind: 'bool', field: 'enableSMBWithCOB', dependsOnSMBAlways: true },
  enableSMBWithTempTarget: { kind: 'bool', field: 'enableSMBWithTempTarget', dependsOnSMBAlways: true },
  enableSMBAfterCarbs: { kind: 'bool', field: 'enableSMBAfterCarbs', dependsOnSMBAlways: true },
  enableSMBWithHighGlucoseTarget: { kind: 'bool', field: 'enableSMBWithHighGlucoseTarget', dependsOnSMBAlways: true },
  allowSMBWithHighTempTarget: { kind: 'bool', field: 'allowSMBWithHighTempTarget' },
  enableUAM: { kind: 'bool', field: 'enableUAM' },
  maxSMBMinutes: { kind: 'decimal', field: 'maxSMBMinutes', picker: PICKERS.maxSMBMinutes, format: 'minutes' },
  maxUAMMinutes: { kind: 'decimal', field: 'maxUAMMinutes', picker: PICKERS.maxUAMMinutes, format: 'minutes' },
  maxDeltaGlucoseThreshold: { kind: 'decimal', field: 'maxDeltaGlucoseThreshold', picker: PICKERS.maxDeltaGlucoseThreshold, format: 'percent' },
  highTempTargetRaisesSensitivity: { kind: 'bool', field: 'highTempTargetRaisesSensitivity' },
  lowTempTargetLowersSensitivity: { kind: 'bool', field: 'lowTempTargetLowersSensitivity' },
  sensitivityRaisesTarget: { kind: 'bool', field: 'sensitivityRaisesTarget' },
  resistanceLowersTarget: { kind: 'bool', field: 'resistanceLowersTarget' },
  halfBasalTarget: { kind: 'decimal', field: 'halfBasalTarget', picker: PICKERS.halfBasalTarget, format: 'glucose' },
};

const formatter = (kind: 'percent' | 'glucose' | 'minutes', units: GlucoseUnit) => (v: number) =>
  kind === 'percent' ? fmtPercent(v) : kind === 'glucose' ? glucoseWithUnits(v, units) : `${fmtNumber(v)} min`;

/** `AlgorithmSettingsSubstepView` for the Autosens, SMB and Target Behavior substeps. */
export function AlgorithmSubstepStep({ substep }: { substep: AlgorithmSubstep }) {
  const units = useOnboardingDraft((s) => s.units);
  const smbAlways = useOnboardingDraft((s) => s.enableSMBAlways);
  const highBg = useOnboardingDraft((s) => s.enableSMBWithHighGlucoseTarget);
  const reportsRewind = useOnboardingDraft((s) => pumpModel(s.pumpModelId).reportsRewindEvents);
  const gu = (v: number) => glucoseWithUnits(v, units);
  const input = ALGORITHM_INPUTS[substep];
  const title = algorithmTitle(substep);
  const disabled = (input.kind === 'bool' && input.dependsOnSMBAlways && smbAlways) || (substep === 'rewindResetsAutosens' && !reportsRewind);
  return (
    <Stack gap={16}>
      <SubstepHeader title={title} hint={algorithmHint(substep, gu)} />
      {input.kind === 'bool' ? (
        <BoolSetting key={substep} label={title} field={input.field} disabled={disabled} />
      ) : (
        <DecimalSetting key={substep} label={title} field={input.field} picker={input.picker} format={formatter(input.format, units)} units={units} />
      )}
      {substep === 'enableSMBWithHighGlucoseTarget' && highBg ? (
        <DecimalSetting label="High Glucose Target" field="highGlucoseTarget" picker={PICKERS.highGlucoseTarget} format={formatter('glucose', units)} units={units} disabled={smbAlways} />
      ) : null}
      <DescriptionBlocks blocks={algorithmDescription(substep, gu)} />
    </Stack>
  );
}
