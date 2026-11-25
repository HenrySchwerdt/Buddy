import { router } from 'expo-router';
import { useState } from 'react';
import { CapsuleButton, SheetScreen } from '@/trio';
import type { CatalogEntry } from '@/features/devices/catalog';
import { CgmSetup } from '@/features/devices/cgm-setup';
import { DevicePicker } from '@/features/devices/device-picker';

/** Trio "Add CGM": DevicePickerView, then the chosen source's setup in the same sheet. */
export default function AddCgm() {
  const [entry, setEntry] = useState<CatalogEntry | null>(null);
  if (!entry) return <DevicePicker kind="cgm" onSelect={setEntry} onCancel={() => router.back()} />;
  return (
    <SheetScreen title={entry.name} leading={<CapsuleButton label="Cancel" onPress={() => router.back()} />}>
      <CgmSetup entry={entry} onFinished={() => router.replace('/cgm-settings')} />
    </SheetScreen>
  );
}
