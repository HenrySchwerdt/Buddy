import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform } from 'react-native';
import { scanNearbyDevices, type NearbyBleDevice } from '@buddy/devices';
import { syncHeartbeatDevice } from '@/runtime/runtime';
import { useSettings } from '@/runtime/settings-store';
import { bleTransport } from '@/runtime/transports/ble';
import { Row, Section, T, useTrioColors } from '@/trio';
import { errorText } from './device-actions';

const SCAN_MS = 8_000;

/**
 * Trio's "heartbeat transmitter" for CGMs that are not Bluetooth themselves (Nightscout, LibreLinkUp, xDrip): pick
 * a nearby Bluetooth device that connects or sends data every few minutes, for example the CGM's own transmitter.
 * Buddy keeps a connection to it and every connect, notification and disconnect wakes the app to loop.
 */
export function HeartbeatDeviceSection() {
  const c = useTrioColors();
  const deviceId = useSettings((s) => s.heartbeatDeviceId);
  const deviceName = useSettings((s) => s.heartbeatDeviceName);
  const update = useSettings((s) => s.update);
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<readonly NearbyBleDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const scan = async () => {
    setScanning(true);
    setError(null);
    setFound([]);
    try {
      const devices = await scanNearbyDevices(bleTransport, { durationMs: SCAN_MS, onFound: (d) => alive.current && setFound(d) });
      if (alive.current) setFound(devices);
    } catch (e) {
      if (alive.current) setError(errorText(e));
    } finally {
      if (alive.current) setScanning(false);
    }
  };

  const choose = async (device: NearbyBleDevice | null) => {
    update({ heartbeatDeviceId: device?.id ?? '', heartbeatDeviceName: device?.name ?? '' });
    setFound([]);
    try {
      await syncHeartbeatDevice();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <Section
      header="Heartbeat"
      footer={
        <T style_="footnote" secondary>
          {`This CGM has no Bluetooth link of its own, so ${Platform.OS === 'ios' ? 'iOS has nothing to wake Buddy with' : 'Android has nothing to wake Buddy with'}. Choose a Bluetooth device near you that connects or sends data every few minutes, such as your CGM's transmitter. Buddy stays connected to it and loops each time it connects, sends data or disconnects. Force-quitting Buddy stops this.`}
        </T>
      }>
      <Row>
        <T style={{ flex: 1 }}>{deviceId ? deviceName || deviceId : 'None'}</T>
        {deviceId ? (
          <T color={c.red} onPress={() => void choose(null)} accessibilityRole="button">
            Remove
          </T>
        ) : null}
      </Row>
      <Row onPress={scanning ? undefined : () => void scan()}>
        <T color={c.tabBar} style={{ flex: 1 }}>
          {scanning ? 'Looking for devices…' : 'Choose Heartbeat Device'}
        </T>
        {scanning ? <ActivityIndicator /> : null}
      </Row>
      {found.map((d) => (
        <Row key={d.id} onPress={() => void choose(d)} accessibilityLabel={`Use ${d.name ?? d.id} as heartbeat`}>
          <T style={{ flex: 1 }}>{d.name ?? d.id}</T>
          <T secondary>{d.rssi === null ? '' : `${d.rssi} dBm`}</T>
        </Row>
      ))}
      {error ? (
        <Row>
          <T color={c.red} style={{ flex: 1 }}>
            {error}
          </T>
        </Row>
      ) : null}
    </Section>
  );
}
