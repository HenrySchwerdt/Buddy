import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import type { Schedule } from '@buddy/core';
import { T, useTrioColors } from '@/trio';
import { useProfiles, useEditableSchedules, type ProfileSchedules } from '../profiles';
import { ScheduleEditor, type EditorItem } from './schedule-editor';

/** Port of TherapyProfileBanner. */
export function ProfileBanner({ name, active }: { name: string; active: boolean }) {
  const c = useTrioColors();
  return (
    <View style={[styles.banner, { backgroundColor: `${c.chart}A6` }]} accessible>
      <T weight="700" style={{ flex: 1 }}>
        Profile {name}
      </T>
      <T color={active ? c.green : c.secondary}>{active ? 'Active' : 'Not active'}</T>
    </View>
  );
}

type Key = keyof ProfileSchedules;

interface Props<K extends Key> {
  readonly scheduleKey: K;
  readonly title: string;
  readonly valueOptions: readonly number[];
  readonly formatValue: (v: number) => string;
  readonly unit: string;
  readonly chart: { color: string; fillsArea?: boolean; lineWidth?: number; yDomain?: readonly [number, number]; accessibilityLabel: string };
  /** Number the editor edits, taken from a stored entry value. */
  readonly read: (v: ProfileSchedules[K][number]['value']) => number;
  readonly write: (v: number) => ProfileSchedules[K][number]['value'];
  readonly footer?: (items: readonly EditorItem[]) => React.ReactNode;
}

/** Glue between a schedule of the live/stored profile (`?profile=` route param) and ScheduleEditor. */
export function TherapyScheduleEditor<K extends Key>({ scheduleKey, read, write, ...rest }: Props<K>) {
  const { profile } = useLocalSearchParams<{ profile?: string }>();
  useProfiles((s) => s.activeName);
  const { schedules, save, banner } = useEditableSchedules(profile);
  const schedule = schedules[scheduleKey] as Schedule<ProfileSchedules[K][number]['value']>;
  const initial = schedule.map((e) => ({ minute: e.startMinute, value: read(e.value) }));
  return (
    <ScheduleEditor
      {...rest}
      key={profile ?? 'live'}
      initial={initial}
      header={banner ? <ProfileBanner name={banner.name} active={banner.active} /> : null}
      onSave={(items) => save({ [scheduleKey]: items.map((i) => ({ startMinute: i.minute, value: write(i.value) })) } as Partial<ProfileSchedules>)}
    />
  );
}

const styles = StyleSheet.create({
  banner: { flexDirection: 'row', alignItems: 'center', padding: 16, borderRadius: 10, marginTop: 8 },
});
