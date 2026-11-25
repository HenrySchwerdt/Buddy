import type { AlertKind } from '@buddy/core';
import { useState } from 'react';
import { Modal, Platform, Switch, View } from 'react-native';
import { useSettings } from '@/runtime/settings-store';
import { CapsuleButton, PickerRow, Row, Section, SheetScreen, T, ToggleRow, useTrioColors, ValueRow } from '@/trio';
import { activeWindow, ALARM_META, formatValue, overridesFocus, pickerValues, readValue, REPEAT_OPTIONS, unitLabel, windowLabel, type ValueSpec } from './alarm-catalog';
import { ValueWheelSection } from './value-wheel';

type Working = Record<string, number | boolean>;

/** GlucoseAlertEditorView / DeviceAlarmEditorView as a page sheet: Cancel · Title · Done. */
export function AlarmEditorSheet({ kind, variant, onClose }: { kind: AlertKind | null; variant: 'glucose' | 'device'; onClose: () => void }) {
  return (
    <Modal visible={kind !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      {kind ? <Editor key={kind} kind={kind} variant={variant} onClose={onClose} /> : null}
    </Modal>
  );
}

function Editor({ kind, variant, onClose }: { kind: AlertKind; variant: 'glucose' | 'device'; onClose: () => void }) {
  const c = useTrioColors();
  const alerts = useSettings((s) => s.alerts);
  const units = useSettings((s) => s.units);
  const update = useSettings((s) => s.update);
  const meta = ALARM_META[kind]!;
  const [working, setWorking] = useState<Working>(() => ({ ...(alerts[kind] as unknown as Working) }));
  const set = (field: string, v: number | boolean) => setWorking((w) => ({ ...w, [field]: v }));
  const enabled = meta.alwaysOn ? true : Boolean(working.enabled);
  const window = windowLabel(activeWindow(kind, alerts.quietHours));

  const save = () => {
    update({ alerts: { ...alerts, [kind]: { ...alerts[kind], ...working } } });
    onClose();
  };

  const valuesFor = (spec: ValueSpec) => {
    const all = pickerValues(spec);
    // Critical escalation must come after the warning.
    if (kind === 'notLooping' && spec.field === 'criticalMinutes') return all.filter((v) => v > Number(working.minutes));
    return all;
  };

  return (
    <SheetScreen
      title={meta.name}
      leading={<CapsuleButton label="Cancel" onPress={onClose} />}
      trailing={<CapsuleButton label="Done" onPress={save} />}>
      {variant === 'glucose' ? (
        <Section header="General" footer={meta.blurb}>
          <ValueRow label="Name" value={meta.name} />
          {meta.alwaysOn ? null : <ToggleRow label="Enabled" value={enabled} onChange={(v) => set('enabled', v)} />}
          <FixedToggle label="Override Silence & Focus Mode" value={overridesFocus(kind)} />
        </Section>
      ) : (
        <Section header="Behavior" footer={meta.blurb}>
          <Row>
            <T style_="headline" style={{ flex: 1 }}>
              {meta.name}
            </T>
            <T style_="footnote" secondary>
              {window}
            </T>
          </Row>
          <ToggleRow label="Enabled" value={enabled} onChange={(v) => set('enabled', v)} />
          <FixedToggle label="Override Silence & Focus Mode" value={overridesFocus(kind)} />
        </Section>
      )}

      {meta.values.map((spec) => {
        const unit = spec.unit === 'min' ? 'min' : unitLabel(spec.unit, units);
        return (
          <ValueWheelSection
            key={spec.field}
            header={spec.header}
            footer={spec.footer}
            title={spec.title}
            value={readValue(working as never, spec.field)}
            values={valuesFor(spec)}
            unit={unit}
            format={(v) => formatValue(v, spec.unit, units)}
            onChange={(v) => {
              set(spec.field, v);
              if (kind === 'notLooping' && spec.field === 'minutes' && Number(working.criticalMinutes) <= v) set('criticalMinutes', v + 10);
            }}
          />
        );
      })}

      <Section header="Repeat" footer="Notifies again while the alarm is still active.">
        <PickerRow label="Repeat Every" value={Number(working.repeatMinutes)} options={REPEAT_OPTIONS} onChange={(v) => set('repeatMinutes', v)} />
      </Section>

      <Section header="Active During" footer="Day and Night windows are configured globally on the Alarms screen. In Buddy, the Night window silences every alarm except Urgent Low.">
        <ValueRow label="Active" value={window} valueColor={c.secondary} />
      </Section>

      <Section header="Audio" footer={overridesFocus(kind) ? (Platform.OS === 'android' ? 'Critical alerts use the Android alarm sound.' : 'Critical alerts use the iOS critical alert sound.') : undefined}>
        <ValueRow label="Sound" value={Platform.OS === 'android' ? 'Android Default' : 'iOS Default'} />
      </Section>
      <View style={{ height: 8 }} />
    </SheetScreen>
  );
}

/** A toggle Buddy decides itself (shown for parity, not editable). */
function FixedToggle({ label, value }: { label: string; value: boolean }) {
  const c = useTrioColors();
  return (
    <Row accessibilityLabel={`${label}, ${value ? 'on' : 'off'}`}>
      <T style={{ flex: 1 }}>{label}</T>
      <Switch value={value} disabled trackColor={{ true: c.tabBar }} />
    </Row>
  );
}
