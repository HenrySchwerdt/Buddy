import { router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from '@/trio/symbol';
import { ActionSheetIOS, Alert, Platform } from 'react-native';
import { LinkButton, NavRow, Row, Section, T, ValueRow, useTrioColors } from '@/trio';
import { useSettings } from '@/runtime/settings-store';
import { SettingsScreen, go } from '@/features/settings/components/settings-screen';
import { fmtMinute } from '@/features/settings/components/schedule-editor';
import { fmtBasal } from '@/features/settings/basal';
import { fmtGlucoseValue } from '@/features/settings/picker';
import { DEFAULT_PROFILE_NAME, nameProblem, useProfileList, useProfiles } from '@/features/settings/profiles';

/** Port of TherapyProfileDetailView. */
export default function TherapyProfileDetail() {
  const { name = DEFAULT_PROFILE_NAME } = useLocalSearchParams<{ name?: string }>();
  return (
    <SettingsScreen title={name}>
      <Detail name={name} />
    </SettingsScreen>
  );
}

function confirm(title: string, message: string, action: string, destructive: boolean, onConfirm: () => void) {
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions({ title, message, options: [action, 'Cancel'], cancelButtonIndex: 1, destructiveButtonIndex: destructive ? 0 : undefined }, (i) => {
      if (i === 0) onConfirm();
    });
  } else {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      { text: action, style: destructive ? 'destructive' : 'default', onPress: onConfirm },
    ]);
  }
}

function Detail({ name }: { name: string }) {
  const c = useTrioColors();
  const units = useSettings((s) => s.units);
  const list = useProfileList();
  const { activeName, activate, rename, remove } = useProfiles();
  const profile = list.find((p) => p.name === name);
  if (!profile) return null;
  const isActive = name === activeName;
  const isDefault = name === DEFAULT_PROFILE_NAME;
  const edit = (route: string) => go(route, { profile: name });

  const schedule = (title: string, route: string, rows: { minute: number; text: string }[]) => (
    <Section header={title}>
      {[
        ...rows.map((r) => <ValueRow key={r.minute} label={fmtMinute(r.minute)} value={r.text} />),
        <NavRow key="edit" label="Edit" onPress={() => edit(route)} />,
      ]}
    </Section>
  );

  return (
    <>
      <Section>
        <Row>
          <SymbolView name={isActive ? 'checkmark.circle.fill' : 'circle'} size={20} tintColor={isActive ? c.green : c.secondary} />
          <T color={isActive ? c.green : c.secondary}>{isActive ? 'Active' : 'Not active'}</T>
        </Row>
      </Section>
      {schedule('Basal Rates', '/settings/therapy-basal', profile.basal.map((e) => ({ minute: e.startMinute, text: `${fmtBasal(e.value)} U/hr` })))}
      {schedule('Carb Ratios', '/settings/therapy-carb-ratios', profile.carbRatio.map((e) => ({ minute: e.startMinute, text: `${e.value} g/U` })))}
      {schedule('Insulin Sensitivities', '/settings/therapy-isf', profile.isf.map((e) => ({ minute: e.startMinute, text: `${fmtGlucoseValue(e.value, units)} ${units}/U` })))}
      {schedule('Glucose Targets', '/settings/therapy-targets', profile.target.map((e) => ({ minute: e.startMinute, text: `${fmtGlucoseValue(e.value.low, units)} ${units}` })))}
      {!isActive || !isDefault ? (
        <Section>
          {[
            !isActive ? (
              <Row key="activate">
                <LinkButton
                  label="Activate Profile"
                  onPress={() =>
                    confirm(`Activate ${name}?`, "Buddy starts using this profile's basal rates, carb ratios, insulin sensitivities and glucose targets right away.", 'Activate', false, () => activate(name))
                  }
                />
              </Row>
            ) : null,
            !isDefault ? (
              <Row key="rename">
                <LinkButton
                  label="Rename Profile"
                  onPress={() =>
                    Alert.prompt(
                      'Rename Profile',
                      'Enter a new name for the profile.',
                      [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Rename',
                          onPress: (to?: string) => {
                            const problem = nameProblem(to ?? '', list.map((p) => p.name), name);
                            if (problem) return Alert.alert('Profile Not Changed', problem);
                            rename(name, to ?? '');
                            router.setParams({ name: (to ?? '').trim() });
                          },
                        },
                      ],
                      'plain-text',
                      name,
                    )
                  }
                />
              </Row>
            ) : null,
            !isDefault && !isActive ? (
              <Row key="delete">
                <LinkButton
                  label="Delete Profile"
                  destructive
                  onPress={() =>
                    confirm(`Delete ${name}?`, 'This cannot be undone.', 'Delete', true, () => {
                      remove(name);
                      router.back();
                    })
                  }
                />
              </Row>
            ) : null,
          ].filter(Boolean)}
        </Section>
      ) : null}
    </>
  );
}
