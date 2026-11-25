import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { DanaPumpDriver } from '@buddy/devices';
import type { PumpPlugin } from '@buddy/core';
import { currentPump } from '@/runtime/runtime';
import { bleTransport } from '@/runtime/transports/ble';
import { PrimaryButton, Row, Section, T, useTrioColors } from '@/trio';
import { activateDevice, errorText, useDeviceValues } from './device-actions';
import { TextFieldRow } from './plugin-form';
import { ChoiceRow, TextRow } from './setup-rows';

const SCAN_MS = 30_000;
const DANA_NAME = /^[a-zA-Z]{3}[0-9]{5}[a-zA-Z]{2}$/;

type Step = 'model' | 'speed' | 'explain' | 'scan';
type Model = 'dana-i' | 'dana-rs';

/** DanaKit onboarding: model → bolus speed → pairing explanation → scan / connect (PINs for RS v3). */
export function DanaSetup({ plugin, entryId, onConnected }: { plugin: PumpPlugin; entryId: string; onConnected: () => void }) {
  const c = useTrioColors();
  const { values, setValue } = useDeviceValues(plugin);
  const [step, setStep] = useState<Step>('model');
  const [model, setModel] = useState<Model>('dana-i');
  const [found, setFound] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [connectingTo, setConnectingTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pin1, setPin1] = useState('');
  const [pin2, setPin2] = useState('');
  const [manual, setManual] = useState('');
  const [scanRun, setScanRun] = useState(0);

  useEffect(() => {
    if (step !== 'scan') return;
    let active = true;
    setScanning(true);
    bleTransport
      .scan({ timeoutMs: SCAN_MS }, (ad) => {
        const name = ad.name?.toUpperCase();
        if (active && name && DANA_NAME.test(name)) setFound((old) => (old.includes(name) ? old : [...old, name]));
      })
      .catch((e: unknown) => active && setError(errorText(e)))
      .finally(() => active && setScanning(false));
    return () => {
      active = false;
      bleTransport.stopScan();
    };
  }, [step, scanRun]);

  const connect = async (name: string) => {
    bleTransport.stopScan();
    setError(null);
    setConnectingTo(name);
    try {
      await activateDevice('pump', plugin, { ...values, deviceName: name, model }, entryId);
      onConnected();
    } catch (e) {
      setError(`Failed to pair to ${name}: ${errorText(e)}`);
    } finally {
      setConnectingTo(null);
    }
  };

  const sendPins = () => {
    const pump = currentPump();
    if (!(pump instanceof DanaPumpDriver)) return setError('No pairing in progress');
    const r = pump.providePincode(pin1, pin2);
    if (!r.ok) setError(r.error);
  };

  if (step === 'model') {
    return (
      <>
        <Section header="Choose your Dana pump">
          <ChoiceRow
            title="Dana-i"
            description="The Dana-I insulin pump was first release in 2020 by manufacturer Sooil and is the latest in the series"
            selected={model === 'dana-i'}
            onPress={() => setModel('dana-i')}
          />
          <ChoiceRow
            title="DanaRS-v3"
            description="The DanaRS insulin pump was first released in 2002. NOTE: only DanaRS pumps with firmware version 3 are supported"
            selected={model === 'dana-rs'}
            onPress={() => setModel('dana-rs')}
          />
        </Section>
        <PrimaryButton label="Continue" onPress={() => setStep('speed')} />
      </>
    );
  }

  if (step === 'speed') {
    const speed = String(values.bolusSpeed ?? '12');
    return (
      <>
        <Section header="Select the bolus delivery speed">
          <ChoiceRow title="12 sec/U" description="The fastest bolus speed option" selected={speed === '12'} onPress={() => setValue('bolusSpeed', '12')} />
          <ChoiceRow title="30 sec/U" description="The middle bolus speed option" selected={speed === '30'} onPress={() => setValue('bolusSpeed', '30')} />
          <ChoiceRow title="60 sec/U" description="The slowest bolus speed option" selected={speed === '60'} onPress={() => setValue('bolusSpeed', '60')} />
        </Section>
        <PrimaryButton label="Continue" onPress={() => setStep('explain')} />
      </>
    );
  }

  if (step === 'explain') {
    return (
      <>
        <Section>
          <TextRow>After setting up the bolus speed, you will see all the found Dana pumps. Select the pump you want to link with Buddy.</TextRow>
          <TextRow>
            {model === 'dana-i'
              ? 'During the pairing process, your Dana-i will show a pairing prompt while your iPhone will show a prompt for a pairing code. On you pump, select OK and type the 6-digit code in screen on your iPhone. After that, Buddy is ready to communicate with your Dana-i'
              : 'During the pairing process, your DanaRS v3 will show a pairing prompt while you iPhone will show a prompt for two pairing codes. On your pump, select OK and type the two codes on your iPhone. After that, Buddy is ready to communicate with your DanaRS v3'}
          </TextRow>
        </Section>
        <PrimaryButton label="Continue" onPress={() => setStep('scan')} />
      </>
    );
  }

  return (
    <>
      <Section header={connectingTo ? 'Connecting' : 'Scanning'}>
        {found.map((name) => (
          <Row key={name} onPress={connectingTo ? undefined : () => void connect(name)} accessibilityLabel={name}>
            <T style={{ flex: 1 }}>{name}</T>
            {connectingTo === name ? <ActivityIndicator /> : null}
          </Row>
        ))}
        {!found.length ? (
          <Row>
            {scanning ? <ActivityIndicator /> : null}
            <T secondary style={{ flex: 1 }}>
              {scanning ? 'Looking for Dana pumps…' : 'No Dana pump found.'}
            </T>
          </Row>
        ) : null}
      </Section>

      {connectingTo && model === 'dana-rs' ? (
        <Section header="Pairing codes" footer="Type the two codes the DanaRS v3 shows on its display.">
          <TextFieldRow label="Pin 1" value={pin1} onChangeText={setPin1} autoCapitalize="characters" maxLength={12} />
          <TextFieldRow label="Pin 2" value={pin2} onChangeText={setPin2} autoCapitalize="characters" maxLength={8} />
        </Section>
      ) : null}
      {connectingTo && model === 'dana-rs' ? <PrimaryButton label="Okay" onPress={sendPins} /> : null}

      {!connectingTo ? (
        <Section header="Enter Manually" footer="The Bluetooth name shown on the pump (3 letters, 5 digits, 2 letters), e.g. ABC12345DE.">
          <TextFieldRow label="Pump name" value={manual} onChangeText={(t) => setManual(t.toUpperCase())} placeholder="ABC12345DE" autoCapitalize="characters" maxLength={10} />
        </Section>
      ) : null}
      {error ? (
        <T color={c.red} style={{ marginHorizontal: 20 }}>
          {error}
        </T>
      ) : null}
      {!connectingTo ? (
        <View style={{ gap: 12 }}>
          <PrimaryButton label="Connect" disabled={!DANA_NAME.test(manual)} onPress={() => void connect(manual)} />
          {!scanning ? <PrimaryButton label="Scan Again" color={c.fill} onPress={() => setScanRun((n) => n + 1)} /> : null}
        </View>
      ) : null}
    </>
  );
}
