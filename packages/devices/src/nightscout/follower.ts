import {
  definePump,
  type CarbEntry,
  type DeviceContext,
  type DeviceMeta,
  type InsulinDose,
  type Millis,
  type PumpDriver,
  type PumpState,
  type ReferenceDecision,
} from '@buddy/core';
import { normalizeBaseUrl, type NightscoutSettings } from './index';

/**
 * Shadow mode: follows another loop (Trio, Loop, AAPS) through Nightscout. Its treatments
 * become Buddy's insulin and carb history, its devicestatus becomes the reference decision.
 * It never accepts commands, so Buddy's algorithm only *suggests* — side by side with Trio.
 */
const META: DeviceMeta = {
  id: 'nightscout-follower',
  name: 'Follow Trio (shadow mode)',
  manufacturer: 'Nightscout',
  description: 'Reads insulin, carbs and decisions of your running loop app from Nightscout. Buddy computes its own suggestion next to it and never doses.',
  transport: 'network',
  maturity: 'stable',
  readOnly: true,
};

const HOUR = 3_600_000;
const READ_ONLY = { ok: false as const, error: 'Shadow mode is read-only: Buddy does not control this pump.' };

type Json = Record<string, unknown>;
const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x)) ? Number(x) : undefined);
const time = (t: Json): number | undefined => {
  const raw = t.created_at ?? t.timestamp ?? t.date ?? t.mills;
  const n = typeof raw === 'number' ? raw : Date.parse(String(raw));
  return Number.isFinite(n) ? n : undefined;
};
const idOf = (t: Json, prefix: string, date: number) => `${prefix}-${String(t._id ?? t.id ?? date)}`;

/** Converts Nightscout treatments (as uploaded by Trio/Loop/AAPS) into delivered doses. */
export function parseTreatmentsToDoses(body: unknown): InsulinDose[] {
  if (!Array.isArray(body)) throw new Error('Nightscout returned an unexpected treatments response');
  return body.flatMap((raw): InsulinDose[] => {
    const t = raw as Json;
    const date = time(t);
    if (date === undefined) return [];
    const type = String(t.eventType ?? '');
    const insulin = num(t.insulin);
    if (insulin !== undefined && insulin > 0 && insulin < 30) {
      const smb = type === 'SMB' || t.isSMB === true || t.type === 'SMB';
      return [{ kind: smb ? 'smb' : 'bolus', id: idOf(t, 'ns-bolus', date), date, units: insulin }];
    }
    if (type === 'Temp Basal') {
      const rate = num(t.absolute) ?? num(t.rate);
      const durationMin = num(t.duration) ?? 0;
      if (rate === undefined || rate < 0 || rate > 35) return [];
      return [{ kind: 'tempBasal', id: idOf(t, 'ns-temp', date), date, rate, durationMin }];
    }
    // Trio uploads suspend/resume as Notes ("PumpSuspend"/"PumpResume"); others use the eventType.
    const marker = type === 'Note' ? String(t.notes ?? '') : type;
    if (marker === 'PumpSuspend') return [{ kind: 'suspend', id: idOf(t, 'ns-suspend', date), date, durationMin: 24 * 60 }];
    if (marker === 'PumpResume') return [{ kind: 'tempBasal', id: idOf(t, 'ns-resume', date), date, rate: 0, durationMin: 0 }];
    return [];
  });
}

export function parseTreatmentsToCarbs(body: unknown): CarbEntry[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((raw): CarbEntry[] => {
    const t = raw as Json;
    const date = time(t);
    const grams = num(t.carbs);
    if (date === undefined || grams === undefined || grams <= 0 || grams > 300) return [];
    const absorptionHours = num(t.absorptionTime) ? num(t.absorptionTime)! / 60 : undefined;
    return [{ id: idOf(t, 'ns-carbs', date), date, grams, absorptionHours }];
  });
}

/** Extracts the latest loop decision from Nightscout devicestatus (openaps.enacted / suggested). */
export function parseDeviceStatus(body: unknown): { decision: ReferenceDecision | null; pump: Partial<PumpState> } {
  const list = Array.isArray(body) ? (body as Json[]) : [];
  for (const s of list) {
    const openaps = s.openaps as Json | undefined;
    const d = (openaps?.enacted ?? openaps?.suggested) as Json | undefined;
    if (!d) continue;
    const date = time(d) ?? time(s) ?? 0;
    const rate = num(d.rate);
    const duration = num(d.duration);
    const pred = d.predBGs as Json | undefined;
    const arr = (k: string) => (Array.isArray(pred?.[k]) ? (pred![k] as number[]) : undefined);
    const pumpJson = s.pump as Json | undefined;
    return {
      decision: {
        source: String(s.device ?? 'Trio').replace(/^openaps:\/\//, ''),
        date,
        tempBasal: rate !== undefined && duration !== undefined ? (duration === 0 ? null : { rate, durationMin: duration }) : undefined,
        autoBolus: num(d.units),
        eventualGlucose: num(d.eventualBG),
        iob: num(d.IOB) ?? num((openaps?.iob as Json | undefined)?.iob),
        cob: num(d.COB),
        reason: typeof d.reason === 'string' ? d.reason : undefined,
        predictions: pred ? { iob: arr('IOB'), zt: arr('ZT'), cob: arr('COB'), uam: arr('UAM') } : undefined,
      },
      pump: {
        reservoirUnits: num(pumpJson?.reservoir) ?? null,
        batteryPercent: num((pumpJson?.battery as Json | undefined)?.percent) ?? null,
        suspended: (pumpJson?.status as Json | undefined)?.suspended === true,
      },
    };
  }
  return { decision: null, pump: {} };
}

export const nightscoutFollower = definePump<NightscoutSettings>({
  meta: META,
  settings: [
    {
      title: 'Nightscout of the loop you follow',
      fields: [
        { kind: 'text', key: 'url', label: 'URL', placeholder: 'https://my-site.example.com' },
        { kind: 'text', key: 'token', label: 'Access token (read)', secret: true },
      ],
    },
  ],
  defaultSettings: { url: '', token: '' },
  create: (settings, ctx) => createFollower(settings, ctx),
});

function createFollower(settings: NightscoutSettings, ctx: DeviceContext): PumpDriver {
  const get = async (path: string, params: Record<string, string>) => {
    const base = normalizeBaseUrl(settings.url);
    const q = new URLSearchParams(params);
    if (settings.token) q.set('token', settings.token);
    const res = await ctx.fetch(`${base}${path}?${q.toString()}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Nightscout HTTP ${res.status}`);
    return res.json() as Promise<unknown>;
  };
  let treatmentsCache: { at: number; since: number; body: unknown } | null = null;
  const treatments = async (since: Millis) => {
    const now = ctx.clock.now();
    if (treatmentsCache && now - treatmentsCache.at < 60_000 && treatmentsCache.since <= since) return treatmentsCache.body;
    const body = await get('/api/v1/treatments.json', { count: '1000', 'find[created_at][$gte]': new Date(since).toISOString() });
    treatmentsCache = { at: now, since, body };
    return body;
  };
  let lastStatus: ReturnType<typeof parseDeviceStatus> = { decision: null, pump: {} };
  const refreshStatus = async () => {
    lastStatus = parseDeviceStatus(await get('/api/v1/devicestatus.json', { count: '10' }));
    return lastStatus;
  };

  return {
    meta: META,
    connect: async () => {
      normalizeBaseUrl(settings.url);
    },
    disconnect: async () => {},
    async status(): Promise<PumpState> {
      const { pump } = await refreshStatus().catch(() => lastStatus);
      const doses = parseTreatmentsToDoses(await treatments(ctx.clock.now() - 6 * HOUR).catch(() => []));
      const temp = doses.filter((d) => d.kind === 'tempBasal').sort((a, b) => b.date - a.date)[0];
      const running = temp && temp.kind === 'tempBasal' && temp.date + temp.durationMin * 60_000 > ctx.clock.now() ? temp : null;
      return {
        reservoirUnits: pump.reservoirUnits ?? null,
        batteryPercent: pump.batteryPercent ?? null,
        suspended: pump.suspended ?? false,
        tempBasal: running ? { rate: running.rate, startedAt: running.date, durationMin: running.durationMin } : null,
        bolusing: false,
        bolusIncrement: 0.05,
        basalIncrement: 0.05,
        lastSync: ctx.clock.now(),
      };
    },
    setTempBasal: async () => READ_ONLY,
    cancelTempBasal: async () => READ_ONLY,
    bolus: async () => READ_ONLY,
    cancelBolus: async () => READ_ONLY,
    suspend: async () => READ_ONLY,
    resume: async () => READ_ONLY,
    history: async (since) => parseTreatmentsToDoses(await treatments(since)).filter((d) => d.date >= since),
    carbHistory: async (since) => parseTreatmentsToCarbs(await treatments(since)).filter((c) => c.date >= since),
    async referenceDecision(at) {
      const { decision } = await refreshStatus();
      return decision && Math.abs(at - decision.date) < 15 * 60_000 ? decision : null;
    },
  };
}

/** Imports the active Nightscout profile as a Buddy therapy profile (mg/dL). */
export function parseNightscoutProfile(body: unknown) {
  const doc = (Array.isArray(body) ? body[0] : body) as Json | undefined;
  const store = doc?.store as Record<string, Json> | undefined;
  const name = String(doc?.defaultProfile ?? Object.keys(store ?? {})[0] ?? '');
  const p = store?.[name];
  if (!p) throw new Error('No profile found in Nightscout');
  const mmol = String(p.units ?? doc?.units ?? '').toLowerCase().includes('mmol');
  const g = (v: number) => (mmol ? Math.round(v * 18.0182) : v);
  const minute = (e: Json) => (num(e.timeAsSeconds) !== undefined ? Math.round(num(e.timeAsSeconds)! / 60) : (() => {
    const [h, m] = String(e.time ?? '00:00').split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  })());
  const sched = (k: string, conv = (v: number) => v) =>
    ((p[k] as Json[] | undefined) ?? []).map((e) => ({ startMinute: minute(e), value: conv(num(e.value) ?? 0) })).sort((a, b) => a.startMinute - b.startMinute);
  const lows = sched('target_low', g);
  const highs = sched('target_high', g);
  const target = lows.map((l) => ({ startMinute: l.startMinute, value: { low: l.value, high: highs.find((h) => h.startMinute === l.startMinute)?.value ?? l.value } }));
  const result = { basal: sched('basal'), isf: sched('sens', g), carbRatio: sched('carbratio'), target, diaHours: num(p.dia) ?? 6 };
  for (const [k, v] of Object.entries(result)) if (Array.isArray(v) && (v.length === 0 || v[0]!.startMinute !== 0)) throw new Error(`Nightscout profile has no valid ${k} schedule`);
  return result;
}
