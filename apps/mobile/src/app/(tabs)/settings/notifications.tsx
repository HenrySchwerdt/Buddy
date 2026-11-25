import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import { Alert, Linking, View } from 'react-native';
import { SnoozeAlertsSheet } from '@/features/settings-b/snooze-sheet';
import { BorderedButton, ButtonCard, UnavailableRow } from '@/features/settings-b/ui';
import { useNotificationsEnabled } from '@/features/settings-b/use-notification-permission';
import { NavRow, Row, Section, T, TrioScreen, useTrioColors } from '@/trio';

/** Trio Settings → Notifications (NotificationsView). */
export default function NotificationsScreen() {
  const c = useTrioColors();
  const enabled = useNotificationsEnabled();
  const [showSnooze, setShowSnooze] = useState(false);
  const warned = useRef(false);

  useEffect(() => {
    if (enabled !== false || warned.current) return;
    warned.current = true;
    Alert.alert(
      '❗ Notifications are Required',
      "Please authorize notifications by tapping 'Open iOS Settings' > 'Notifications' and enable 'Allow Notifications' for 'Notification Center' and 'Banners' Alerts.",
      [{ text: 'Ok' }],
    );
  }, [enabled]);

  const openSettings = () => {
    Linking.openSettings().catch((e: unknown) => Alert.alert('Could not open Settings', e instanceof Error ? e.message : String(e)));
  };

  return (
    <TrioScreen back title="Notifications">
      <Section header="Mute Buddy Alarms">
        <ButtonCard>
          <BorderedButton label="Snooze All Alarms" icon="zzz" bold onPress={() => setShowSnooze(true)} />
        </ButtonCard>
      </Section>

      <Section header="Manage iOS Preferences">
        <Row accessibilityLabel={`Notifications, ${enabled === false ? 'Off' : 'On'}`}>
          <T style={{ flex: 1 }}>Notifications</T>
          {enabled === false ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <SymbolView name="exclamationmark.triangle.fill" size={16} tintColor={c.red} />
              <T>Off</T>
            </View>
          ) : enabled === true ? (
            <T>On</T>
          ) : null}
        </Row>
        <Row onPress={openSettings} accessibilityLabel="Open iOS Settings">
          <T style={{ flex: 1 }} color={c.tabBar}>
            Open iOS Settings
          </T>
          <SymbolView name="chevron.right" size={13} tintColor={c.secondary} weight="semibold" />
        </Row>
      </Section>

      <Section header="Notification Center">
        <NavRow label="Glucose Alarms" onPress={() => router.push('/settings/notifications-glucose')} />
        <NavRow label="Device Alarms" onPress={() => router.push('/settings/notifications-device')} />
        <NavRow label="Day & Night Windows" onPress={() => router.push('/settings/notifications-windows')} />
      </Section>

      <Section header="Other Notifications">
        <UnavailableRow label="Live Activity" />
        <UnavailableRow label="Calendar Events" />
      </Section>

      <SnoozeAlertsSheet visible={showSnooze} onClose={() => setShowSnooze(false)} />
    </TrioScreen>
  );
}
