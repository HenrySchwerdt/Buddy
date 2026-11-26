import * as LocalAuthentication from 'expo-local-authentication';
import { useRuntime } from './runtime';

/**
 * Trio `UnlockManager.unlock`: before a manual bolus the owner has to authenticate with Face ID / Touch ID /
 * fingerprint, falling back to the device passcode (`deviceOwnerAuthentication`). Throws when it fails, so no bolus is sent.
 */
export async function requireUnlock(): Promise<void> {
  const level = await LocalAuthentication.getEnrolledLevelAsync();
  if (level === LocalAuthentication.SecurityLevel.NONE) {
    throw new Error('Set a device passcode or biometrics to confirm a bolus.');
  }
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: 'We need to make sure you are the owner of the device.',
    cancelLabel: 'Cancel',
  });
  if (!result.success) {
    throw new Error(result.error === 'user_cancel' || result.error === 'system_cancel' || result.error === 'app_cancel' ? 'Authentication cancelled' : 'Authentication failed');
  }
}

/** `requireUnlock` for a real pump; the demo world has no real insulin, so it skips the prompt. */
export async function requireBolusUnlock(): Promise<void> {
  if (useRuntime.getState().demo) return;
  await requireUnlock();
}
