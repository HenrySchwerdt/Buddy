import { useState } from 'react';
import { Alert, Modal, Platform, Switch, View } from 'react-native';
import { useSettings } from '@/runtime/settings-store';
import { CapsuleButton, InputRow, LinkButton, PickerRow, Row, Section, SheetScreen, T, ToggleRow, useTrioColors, ValueRow } from '@/trio';
import { SymbolView } from '@/trio/symbol';
import { formatValue, overridesFocus, pickerValues, REPEAT_OPTIONS, unitLabel } from './alarm-catalog';
import { useGlucoseAlarms } from './alarm-store';
import { soundName } from './alarm-sounds';
import { availableWindows, canDelete, MAX_ALARM_NAME, metaFor, windowName, type GlucoseAlarm } from './alarms';
import { TonePickerSheet } from './tone-picker';
import { ValueWheelSection } from './value-wheel';

/** GlucoseAlertEditorView as a page sheet: Cancel · Title · Done. `alarm` is null while closed. */
export function GlucoseAlarmEditorSheet({ alarm, isNew, onClose }: { alarm: GlucoseAlarm | null; isNew?: boolean; onClose: () => void }) {
  return (
    <Modal visible={alarm !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      {alarm ? <Editor key={alarm.id} initial={alarm} isNew={isNew === true} onClose={onClose} /> : null}
    </Modal>
  );
}

function Editor({ initial, isNew, onClose }: { initial: GlucoseAlarm; isNew: boolean; onClose: () => void }) {
  const c = useTrioColors();
  const units = useSettings((s) => s.units);
  const alarms = useGlucoseAlarms((s) => s.alarms);
  const [draft, setDraft] = useState(initial);
  const [tones, setTones] = useState(false);
  const meta = metaFor(draft.kind);
  const spec = meta.values[0]!;
  const set = (patch: Partial<GlucoseAlarm>) => setDraft((d) => ({ ...d, ...patch }));
  const windows = availableWindows(draft.kind, alarms, draft.id);
  const windowOptions = windows.map((w) => ({ value: w, label: windowName(w) }));
  const windowOk = windows.includes(draft.window);
  const deletable = !isNew && canDelete(initial, alarms);

  const save = () => {
    useGlucoseAlarms.getState().save(draft);
    onClose();
  };
  const remove = () =>
    Alert.alert(`Delete ${initial.name}?`, 'This alarm will no longer fire.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          useGlucoseAlarms.getState().remove(initial.id);
          onClose();
        },
      },
    ]);

  return (
    <SheetScreen
      title={isNew ? 'New Alarm' : meta.name}
      leading={<CapsuleButton label="Cancel" onPress={onClose} />}
      trailing={<CapsuleButton label="Done" onPress={windowOk ? save : () => undefined} color={windowOk ? undefined : c.secondary} />}>
      <Section header="General" footer={meta.blurb}>
        <InputRow label="Name" value={draft.name} onChangeText={(name) => set({ name })} placeholder={meta.name} keyboardType="default" maxLength={MAX_ALARM_NAME} />
        {meta.alwaysOn ? null : <ToggleRow label="Enabled" value={draft.enabled} onChange={(enabled) => set({ enabled })} />}
        <Row accessibilityLabel={`Override Silence and Focus Mode, ${overridesFocus(draft.kind) ? 'on' : 'off'}`}>
          <T style={{ flex: 1 }}>Override Silence & Focus Mode</T>
          <Switch value={overridesFocus(draft.kind)} disabled trackColor={{ true: c.tabBar }} />
        </Row>
      </Section>

      <ValueWheelSection
        header={spec.header}
        footer={spec.footer}
        title={spec.title}
        value={draft.value}
        values={pickerValues(spec)}
        unit={unitLabel(spec.unit, units)}
        format={(v) => formatValue(v, spec.unit, units)}
        onChange={(value) => set({ value })}
      />

      <Section header="Repeat" footer="Notifies again while the alarm is still active.">
        <PickerRow label="Repeat Every" value={draft.repeatMinutes} options={REPEAT_OPTIONS} onChange={(repeatMinutes) => set({ repeatMinutes })} />
      </Section>

      {meta.alwaysOn ? (
        <Section header="Active During" footer="Urgent Low is the safety floor: it is always active, day and night.">
          <ValueRow label="Active" value={windowName('always')} valueColor={c.secondary} />
        </Section>
      ) : (
        <Section
          header="Active During"
          footer={windows.length === 0 ? 'Every window already has an alarm of this type.' : 'Day and Night start at the times set under Day & Night Windows. Alarms of one type cannot overlap.'}>
          <PickerRow label="Active" value={windowOk ? draft.window : (windows[0] ?? draft.window)} options={windowOptions.length ? windowOptions : [{ value: draft.window, label: windowName(draft.window) }]} onChange={(window) => set({ window })} />
        </Section>
      )}

      <Section header="Alert Sound" footer={overridesFocus(draft.kind) ? (Platform.OS === 'android' ? 'Critical alerts use the Android alarm sound.' : 'Critical alerts use the iOS critical alert sound.') : undefined}>
        <ToggleRow label="Play Sound" value={draft.playsSound} onChange={(playsSound) => set({ playsSound })} />
        {draft.playsSound ? (
          <Row onPress={() => setTones(true)} accessibilityLabel={`Tone, ${soundName(draft.soundId)}`}>
            <T style={{ flex: 1 }}>Tone</T>
            <T secondary>{soundName(draft.soundId)}</T>
            <SymbolView name="chevron.right" size={13} tintColor={c.secondary} weight="semibold" />
          </Row>
        ) : null}
      </Section>

      {deletable ? (
        <Section>
          <View style={{ padding: 8, alignItems: 'center' }}>
            <LinkButton label="Delete Alarm" destructive onPress={remove} />
          </View>
        </Section>
      ) : null}
      <View style={{ height: 8 }} />
      <TonePickerSheet visible={tones} selected={draft.soundId} onSelect={(soundId) => set({ soundId })} onClose={() => setTones(false)} />
    </SheetScreen>
  );
}
