import { useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import { T, useTrioColors } from '@/trio';
import type { GriResult } from './calc';
import { DYN, alpha, fixed, pctOne, upTo } from './format';
import { Divider, Row, Unavailable } from './ui';

const ZONES = [
  { score: 20, title: 'A', color: '#30D158' },
  { score: 40, title: 'B', color: '#FFD60A' },
  { score: 60, title: 'C', color: '#FF9F0A' },
  { score: 80, title: 'D', color: '#FF453A' },
  { score: 100, title: 'E', color: '#944D47' },
] as const;

export const griColor = (score: number) => ZONES.find((z) => score <= z.score)?.color ?? ZONES[4].color;

/** GRIChartView: score header + hypo/hyper risk grid with A–E zone bands. */
export function GriChart({ result }: { result: GriResult | null }) {
  const c = useTrioColors();
  const [w, setW] = useState(0);
  return (
    <View style={{ gap: 16 }}>
      <Row style={{ gap: 8 }}>
        <T style_="subheadline" weight="600">
          GRI
        </T>
        {result ? (
          <>
            <T style_="headline">{fixed(result.score, 1)}</T>
            <T secondary>/ 100</T>
            <View style={{ flex: 1 }} />
            <T color={griColor(result.score)}>{`Zone ${result.zone}`}</T>
          </>
        ) : (
          <T>—</T>
        )}
      </Row>
      {result ? (
        <View onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)} style={{ aspectRatio: 1 }} accessible accessibilityLabel="Glycemia risk grid">
          {w > 0 ? <RiskGrid result={result} size={w} axis={c.secondary} /> : null}
        </View>
      ) : (
        <Unavailable title="No Glucose Data" icon="chart.bar.fill" />
      )}
    </View>
  );
}

function RiskGrid({ result, size, axis }: { result: GriResult; size: number; axis: string }) {
  const pad = 36;
  const side = size - pad - 8;
  const xMax = Math.max(30, Math.ceil(result.hypo / 5) * 5);
  const yMax = Math.max(60, Math.ceil(result.hyper / 10) * 10);
  const px = (hypo: number) => pad + (hypo / xMax) * side;
  const py = (hyper: number) => 8 + side - (hyper / yMax) * side;
  // Zones are bands between the lines 3·hypo + 1.6·hyper = score; draw largest first.
  const band = (score: number) => `M${px(0)},${py(0)}L${px(score / 3)},${py(0)}L${px(0)},${py(score / 1.6)}Z`;
  return (
    <Svg width={size} height={size}>
      <Rect x={pad} y={8} width={side} height={side} fill={alpha(ZONES[4].color, 0.35)} />
      {[...ZONES]
        .slice(0, 4)
        .reverse()
        .map((z) => (
          <Path key={z.title} d={band(z.score)} fill={alpha(z.color, 0.35)} />
        ))}
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <SvgText key={`x${f}`} x={pad + f * side} y={size - 14} fontSize={11} fill={axis} textAnchor="middle">
          {upTo(f * xMax, 1)}
        </SvgText>
      ))}
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <SvgText key={`y${f}`} x={pad - 6} y={8 + side - f * side + 4} fontSize={11} fill={axis} textAnchor="end">
          {upTo(f * yMax, 1)}
        </SvgText>
      ))}
      <Line x1={pad} x2={pad + side} y1={8 + side} y2={8 + side} stroke={axis} strokeWidth={0.5} />
      <Line x1={pad} x2={pad} y1={8} y2={8 + side} stroke={axis} strokeWidth={0.5} />
      <SvgText x={pad + side / 2} y={size - 1} fontSize={12} fill={axis} textAnchor="middle">
        Hypoglycemia Component (%)
      </SvgText>
      <Circle cx={px(Math.min(result.hypo, xMax))} cy={py(Math.min(result.hyper, yMax))} r={6} fill="#FFFFFF" stroke="#000000" strokeWidth={1.5} />
    </Svg>
  );
}

/** GRIExplanationView. */
export function GriExplanation({ result }: { result: GriResult | null }) {
  return (
    <View style={{ gap: 16 }}>
      <T>Glycemia Risk Index combines low and high glucose exposure into a score from 0 to 100. Lower scores indicate less glycemic risk.</T>
      <T style_="footnote" secondary>
        Calculated from glucose readings in the selected period. Short periods and gaps in sensor data can make the score less representative.
      </T>
      {result ? (
        <>
          <Row style={{ justifyContent: 'space-between' }}>
            <T color={DYN.red}>Hypoglycemia component</T>
            <T color={DYN.red}>{pctOne(result.hypo / 100)}</T>
          </Row>
          <Row style={{ justifyContent: 'space-between' }}>
            <T color={DYN.purple}>Hyperglycemia component</T>
            <T color={DYN.purple}>{pctOne(result.hyper / 100)}</T>
          </Row>
        </>
      ) : null}
      <Divider />
      {result ? (
        <View style={{ gap: 8 }}>
          <T style_="subheadline" weight="600">
            Score calculation
          </T>
          <T style_="footnote" secondary>
            GRI uses fixed glucose thresholds, regardless of your target range or display units.
          </T>
          <T style_="footnote">{`${fixed(result.veryLow, 1)} + 0.8 × ${fixed(result.low, 1)} = ${fixed(result.hypo, 1)}`}</T>
          <T style_="footnote">{`${fixed(result.veryHigh, 1)} + 0.5 × ${fixed(result.high, 1)} = ${fixed(result.hyper, 1)}`}</T>
          <T style_="footnote">{`3 × ${fixed(result.hypo, 1)} + 1.6 × ${fixed(result.hyper, 1)} = ${fixed(result.score, 1)}`}</T>
          <T style_="footnote" secondary>
            The final GRI score is capped at 100. Calculations use unrounded values.
          </T>
        </View>
      ) : null}
    </View>
  );
}
