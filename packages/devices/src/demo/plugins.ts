import { defineCgm, definePump, type SettingsSection } from '@buddy/core';
import { COHORT } from '@buddy/simulator';
import { demoHub, type DemoOptions } from './hub';

export interface DemoSettings {
  readonly [key: string]: string | number | boolean;
  patientId: string;
  speed: number;
  seed: number;
}

const SETTINGS: SettingsSection[] = [
  {
    title: 'Virtual patient',
    fields: [
      { kind: 'select', key: 'patientId', label: 'Patient', options: COHORT.map((p) => ({ value: p.id, label: `${p.name} — ${p.description}` })) },
      { kind: 'number', key: 'speed', label: 'Time speed', help: 'Simulated minutes per real minute.', unit: '×', min: 1, max: 120, step: 1 },
      { kind: 'number', key: 'seed', label: 'Random seed', min: 1, max: 9999, step: 1 },
    ],
  },
];

const DEFAULTS: DemoSettings = { patientId: 'adult-avg', speed: 30, seed: 7 };
const toOptions = (s: DemoSettings): DemoOptions => ({ patientId: s.patientId, speed: s.speed, seed: s.seed, warmupHours: 6 });

export const demoPump = definePump<DemoSettings>({
  meta: {
    id: 'demo-pump',
    name: 'Demo Pump',
    manufacturer: 'Buddy',
    description: 'Simulated pump attached to a virtual patient. Safe for exploring the app.',
    transport: 'simulated',
    maturity: 'simulator',
  },
  settings: SETTINGS,
  defaultSettings: DEFAULTS,
  create: (settings) => demoHub.ensure(toOptions(settings)).pump,
});

export const demoCgm = defineCgm<DemoSettings>({
  meta: {
    id: 'demo-cgm',
    name: 'Demo CGM',
    manufacturer: 'Buddy',
    description: 'Simulated CGM (lag + noise) reading the same virtual patient as the Demo Pump.',
    transport: 'simulated',
    maturity: 'simulator',
  },
  settings: SETTINGS,
  defaultSettings: DEFAULTS,
  create: (settings) => demoHub.ensure(toOptions(settings)).cgm,
});
