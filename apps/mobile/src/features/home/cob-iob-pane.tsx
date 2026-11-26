import { G, Line, Path } from 'react-native-svg';
import { cobIobDomain, scaledIob, type CobIobPoint } from './cob-iob';
import { DARKER_BLUE, type Frame } from './chart-layers';

interface Props {
  readonly f: Frame;
  readonly top: number;
  /** Plot height (the hour labels sit below it). */
  readonly height: number;
  readonly history: readonly CobIobPoint[];
  readonly projection: readonly CobIobPoint[];
}

/** COB (orange) and scaled IOB (blue) as line + area, with dashed decay projections (CobIobChart). */
export function CobIobPane({ f, top, height, history, projection }: Props) {
  const d = cobIobDomain([...history, ...projection]);
  const span = Math.max(1e-6, d.max - d.min);
  const y = (v: number) => top + (1 - (v - d.min) / span) * height;
  const base = y(0);
  const series = (pts: readonly CobIobPoint[], pick: (p: CobIobPoint) => number) => pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${f.x(p.t).toFixed(1)},${y(pick(p)).toFixed(1)}`).join(' ');
  const area = (pts: readonly CobIobPoint[], pick: (p: CobIobPoint) => number) => (pts.length > 1 ? `${series(pts, pick)} L${f.x(pts.at(-1)!.t).toFixed(1)},${base.toFixed(1)} L${f.x(pts[0]!.t).toFixed(1)},${base.toFixed(1)} Z` : null);
  const cob = (p: CobIobPoint) => p.cob;
  const iob = (p: CobIobPoint) => scaledIob(p.iob);
  const layer = (pts: readonly CobIobPoint[], pick: (p: CobIobPoint) => number, color: string, projected: boolean, key: string) => {
    if (pts.length < 2) return null;
    return (
      <G key={key}>
        <Path d={area(pts, pick) ?? ''} fill={color} fillOpacity={projected ? 0.1 : 0.2} />
        <Path d={series(pts, pick)} stroke={color} strokeOpacity={projected ? 0.8 : 1} strokeWidth={projected ? 1.5 : 2} strokeDasharray={projected ? '4 3' : undefined} fill="none" />
      </G>
    );
  };
  return (
    <G>
      <Line x1={0} x2={f.plotW} y1={base} y2={base} stroke={f.c.secondary} strokeOpacity={0.3} strokeWidth={0.5} />
      {layer(history, cob, f.c.orange, false, 'cob')}
      {layer(history, iob, DARKER_BLUE, false, 'iob')}
      {layer(projection, cob, f.c.orange, true, 'cobp')}
      {layer(projection, iob, DARKER_BLUE, true, 'iobp')}
    </G>
  );
}
