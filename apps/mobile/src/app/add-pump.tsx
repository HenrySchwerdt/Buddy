import { router } from 'expo-router';
import { useState } from 'react';
import { CapsuleButton, SheetScreen } from '@/trio';
import type { CatalogEntry } from '@/features/devices/catalog';
import { DevicePicker } from '@/features/devices/device-picker';
import { PumpSetup } from '@/features/devices/pump-setup';

/** Trio "Add Pump": DevicePickerView, then the chosen driver's setup in the same sheet. */
export default function AddPump() {
  const [entry, setEntry] = useState<CatalogEntry | null>(null);
  if (!entry) return <DevicePicker kind="pump" onSelect={setEntry} onCancel={() => router.back()} />;
  return (
    <SheetScreen title={entry.name} leading={<CapsuleButton label="Cancel" onPress={() => router.back()} />}>
      <PumpSetup entry={entry} onFinished={() => router.replace('/pump-settings')} />
    </SheetScreen>
  );
}
