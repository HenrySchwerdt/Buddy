import { useEffect, useState } from 'react';
import { useSettings } from '@/runtime/settings-store';
import { Section } from '@/trio';
import { AddAlarmSheet } from './add-alarm-sheet';
import { startGlucoseAlarmSync, useGlucoseAlarms } from './alarm-store';
import { newAlarm, type GlucoseAlarm } from './alarms';
import { GlucoseAlarmEditorSheet } from './glucose-alarm-editor';
import { GlucoseAlarmRow } from './glucose-alarm-row';

startGlucoseAlarmSync();

/**
 * Enabled / Disabled sections of the Glucose Alarms screen plus the editor and Add Alarm sheets
 * (GlucoseAlerts.RootView). The parent owns the "+" toolbar button and passes `adding`.
 */
export function GlucoseAlarmsList({ adding, onAddingChange }: { adding: boolean; onAddingChange: (v: boolean) => void }) {
  const alarms = useGlucoseAlarms((s) => s.alarms);
  const units = useSettings((s) => s.units);
  const [editing, setEditing] = useState<{ alarm: GlucoseAlarm; isNew: boolean } | null>(null);
  const [picked, setPicked] = useState<GlucoseAlarm | null>(null);

  // The Add sheet closes before the editor opens (two sheets cannot be presented at once).
  useEffect(() => {
    if (!adding && picked) {
      setEditing({ alarm: picked, isNew: true });
      setPicked(null);
    }
  }, [adding, picked]);

  const enabled = alarms.filter((a) => a.enabled);
  const disabled = alarms.filter((a) => !a.enabled);
  const open = (alarm: GlucoseAlarm) => setEditing({ alarm, isNew: false });

  return (
    <>
      {enabled.length ? (
        <Section header="Enabled">
          {enabled.map((a) => (
            <GlucoseAlarmRow key={a.id} alarm={a} units={units} onPress={() => open(a)} />
          ))}
        </Section>
      ) : null}
      {disabled.length ? (
        <Section header="Disabled">
          {disabled.map((a) => (
            <GlucoseAlarmRow key={a.id} alarm={a} units={units} dimmed onPress={() => open(a)} />
          ))}
        </Section>
      ) : null}
      <AddAlarmSheet
        visible={adding}
        alarms={alarms}
        onClose={() => onAddingChange(false)}
        onPick={(kind) => {
          // First free window: Day & Night, else whichever is left.
          const taken = new Set(alarms.filter((a) => a.kind === kind).map((a) => a.window));
          const window = taken.size === 0 ? 'always' : taken.has('day') ? 'night' : 'day';
          setPicked(newAlarm(kind, window, alarms));
          onAddingChange(false);
        }}
      />
      <GlucoseAlarmEditorSheet alarm={editing?.alarm ?? null} isNew={editing?.isNew} onClose={() => setEditing(null)} />
    </>
  );
}
