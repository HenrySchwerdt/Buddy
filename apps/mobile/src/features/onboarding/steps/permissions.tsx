import { OT } from '../theme';
import { BenefitRow, Stack } from '../ui';
import { SYSTEM_SETTINGS } from '@/features/platform-copy';

export function NotificationPermissionStep() {
  return (
    <Stack style={{ paddingHorizontal: 16 }}>
      <OT style_="title3" weight="700">
        Allow Notifications
      </OT>
      <OT secondary style={{ paddingBottom: 16 }}>
        Buddy can notify of different events when you use it. You must allow Buddy to send you notifications to work properly.
      </OT>
      <Stack>
        <BenefitRow icon="ellipsis.message.fill" text="Receive optional real‑time low/high glucose alerts." />
        <BenefitRow icon="exclamationmark.triangle.fill" text="Be warned of connectivity or looping issues." />
        <BenefitRow icon="app.badge.fill" text="See a badge count when you need a carb correction." />
      </Stack>
      <OT style_="footnote" secondary style={{ paddingTop: 16 }}>
        You can change these permissions any time in the {SYSTEM_SETTINGS} app.
      </OT>
    </Stack>
  );
}

export function BluetoothPermissionStep() {
  return (
    <Stack style={{ paddingHorizontal: 16 }}>
      <OT style_="title3" weight="700">
        Enable device connectivity
      </OT>
      <OT secondary style={{ paddingBottom: 16 }}>
        Buddy requires Bluetooth to function as a (hybrid) closed‑loop system.
      </OT>
      <Stack>
        <BenefitRow icon="keyboard.onehanded.left.fill" text="Connect to your insulin pump so Buddy can send dosing commands and stay active in the background." />
        <BenefitRow icon="sensor.tag.radiowaves.forward.fill" text="Receive glucose readings every 5 minutes from your CGM to keep the loop running." />
      </Stack>
      <OT style_="footnote" secondary style={{ paddingTop: 16 }}>
        You can change these permissions any time in the {SYSTEM_SETTINGS} app.
      </OT>
    </Stack>
  );
}
