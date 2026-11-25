import * as Notifications from 'expo-notifications';
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

/**
 * Mirrors Trio's AlertPermissionsChecker: `null` while unknown, then whether notifications
 * are allowed. Re-checks whenever the app returns to the foreground (e.g. from iOS Settings).
 */
export function useNotificationsEnabled(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const check = useCallback(() => {
    Notifications.getPermissionsAsync()
      .then((p) => setEnabled(p.granted))
      .catch((e: unknown) => {
        console.warn('[notifications] permission check failed', e);
        setEnabled(false);
      });
  }, []);
  useEffect(() => {
    check();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') check();
    });
    return () => sub.remove();
  }, [check]);
  return enabled;
}
