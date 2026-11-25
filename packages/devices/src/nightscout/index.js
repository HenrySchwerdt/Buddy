import { defineCgm } from '@buddy/core';
import { isPlausibleGlucose, trendFromDirection } from '../trend';
const MAX_ENTRIES = 288;
/** Parses a Nightscout `entries/sgv.json` response, dropping anything implausible. */
export function parseNightscoutEntries(body, source) {
    if (!Array.isArray(body))
        throw new Error('Nightscout returned an unexpected response');
    return body.flatMap((e) => {
        if (typeof e !== 'object' || e === null)
            return [];
        const { sgv, date, direction, noise } = e;
        if (!isPlausibleGlucose(sgv) || typeof date !== 'number')
            return [];
        return [{ date, value: sgv, trend: trendFromDirection(direction), source, noise: typeof noise === 'number' ? noise : undefined }];
    });
}
export function normalizeBaseUrl(raw) {
    const url = raw.trim().replace(/\/+$/, '');
    if (!/^https:\/\//i.test(url))
        throw new Error('Nightscout URL must start with https://');
    return url;
}
/** Follows a Nightscout site as CGM source (read-only, via the v1 API). */
const NIGHTSCOUT_META = {
    id: 'nightscout-cgm',
    name: 'Nightscout',
    manufacturer: 'Nightscout',
    description: 'Reads glucose from a Nightscout site. Works with any CGM that uploads to Nightscout.',
    transport: 'network',
    maturity: 'stable',
};
export const nightscoutCgm = defineCgm({
    meta: NIGHTSCOUT_META,
    settings: [
        {
            title: 'Site',
            fields: [
                { kind: 'text', key: 'url', label: 'URL', placeholder: 'https://my-site.example.com' },
                { kind: 'text', key: 'token', label: 'Access token (read)', secret: true },
            ],
        },
    ],
    defaultSettings: { url: '', token: '' },
    create(settings, ctx) {
        const source = 'nightscout';
        return {
            meta: NIGHTSCOUT_META,
            start: async () => {
                normalizeBaseUrl(settings.url);
            },
            stop: async () => { },
            async readings(since) {
                const base = normalizeBaseUrl(settings.url);
                const params = new URLSearchParams({ count: String(MAX_ENTRIES), 'find[date][$gt]': String(Math.floor(since)) });
                if (settings.token)
                    params.set('token', settings.token);
                const res = await ctx.fetch(`${base}/api/v1/entries/sgv.json?${params.toString()}`, { headers: { Accept: 'application/json' } });
                if (!res.ok)
                    throw new Error(`Nightscout HTTP ${res.status}`);
                return parseNightscoutEntries(await res.json(), source);
            },
        };
    },
});
