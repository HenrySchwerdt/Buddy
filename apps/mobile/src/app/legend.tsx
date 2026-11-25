import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { PrimaryButton, SheetScreen, T, useTrioColors } from '@/trio';

/** ChartLegendView port. */
export default function LegendSheet() {
  const c = useTrioColors();
  const sections: { title: string; intro?: string; items: { term: string; def: string; color: string; shape: 'line' | 'dot' | 'triangle' | 'area' | 'none' }[] }[] = [
    {
      title: 'Chart Gestures',
      items: [
        { term: 'Drag', def: 'Pans the chart through time. Flick and let go to keep it gliding.', color: c.primary, shape: 'none' },
        { term: 'Pinch', def: 'Zooms continuously, between one hour and a full day on screen.', color: c.primary, shape: 'none' },
        { term: 'Double-Tap', def: 'Steps through the zoom presets — 6, 12 and 24 hours — keeping the right-hand edge of the window where it is.', color: c.primary, shape: 'none' },
        { term: 'Press and Hold', def: 'Rest a finger on the chart to inspect a single reading with its IOB and COB. Keep your finger down and slide to scrub along the curve.', color: c.primary, shape: 'none' },
      ],
    },
    {
      title: 'Forecasts',
      intro: 'The oref algorithm determines insulin dosing based on a number of scenarios that it estimates with different types of forecasts.',
      items: [
        { term: 'IOB (Insulin on Board)', def: 'Forecasts future glucose readings based on the amount of insulin still active in the body.', color: c.insulin, shape: 'line' },
        { term: 'ZT (Zero-Temp)', def: 'Forecasts the worst-case future glucose reading scenario if no carbs are absorbed and insulin delivery is stopped until glucose starts rising.', color: c.zt, shape: 'line' },
        { term: 'COB (Carbs on Board)', def: 'Forecasts future glucose reading changes by considering the amount of carbohydrates still being absorbed in the body.', color: c.carbs, shape: 'line' },
        { term: 'UAM (Unannounced Meal)', def: 'Forecasts future glucose levels and insulin dosing needs for unexpected meals or other causes of glucose reading increases without prior notice.', color: c.uam, shape: 'line' },
        { term: 'Cone of Uncertainty', def: "For simplicity reasons, oref's various forecast curves are displayed as a \"Cone of Uncertainty\" that depicts a possible, forecasted range of future glucose fluctuation based on the current data and the algorithm's result.", color: c.insulin, shape: 'area' },
      ],
    },
    {
      title: 'Other Elements & Shapes',
      items: [
        { term: 'Scheduled Basal Rate', def: 'This dotted line represents the hourly insulin rate of your scheduled basal insulin.', color: c.insulin, shape: 'line' },
        { term: 'Temporary Basal Rate (TBR)', def: 'Shows current or past TBRs, which can be set by the oref algorithm or manually.', color: c.insulin, shape: 'area' },
        { term: 'Pump Suspension', def: 'Indicates when insulin delivery was paused, i.e. pump is suspended.', color: c.loopGray, shape: 'area' },
        { term: 'CGM Glucose Value', def: 'Glucose readings from your CGM, coloured by range.', color: c.loopGreen, shape: 'dot' },
        { term: 'Manual Glucose Measurement', def: 'Manually entered blood glucose, such as a fingerstick test.', color: c.red, shape: 'dot' },
        { term: 'Bolus', def: 'Shows an insulin dose, which can be a small automated dose (super-micro-bolus), a manually entered dose, or one given externally (e.g., a pen shot).', color: c.insulin, shape: 'triangle' },
        { term: 'Carb Entry', def: 'Tracks the carbohydrates you eat, entered to guide insulin dosing.', color: c.carbs, shape: 'dot' },
        { term: 'Fat-Protein Carb Equivalent', def: 'Represents carb equivalent for fat and protein, calculated using the Warsaw Method.', color: c.carbs, shape: 'dot' },
        { term: 'Override', def: 'Indicates when an override is or was active, temporarily changing therapy settings (e.g., basal rate, insulin sensitivity, carb ratio, target glucose, or whether Buddy can dose SMBs).', color: c.purple, shape: 'area' },
        { term: 'Temporary Target', def: 'Marks when a short-term temporary glucose target is or was active, (potentially) altering when or how much insulin is delivered.', color: c.loopGreen, shape: 'area' },
      ],
    },
  ];
  return (
    <SheetScreen title="Chart Legend" footer={<PrimaryButton label="Got it!" onPress={() => router.back()} color={c.fill} />}>
      <T secondary>The main chart in Buddy is made up of various elements and shapes. Find their meanings below.</T>
      {sections.map((s) => (
        <View key={s.title} style={[styles.card, { backgroundColor: c.dark ? 'rgba(128,128,128,0.1)' : 'rgba(128,128,128,0.1)' }]}>
          <T weight="700" style={{ textTransform: 'uppercase', marginBottom: 6 }}>
            {s.title}
          </T>
          {s.intro ? (
            <T style_="subheadline" secondary style={{ marginBottom: 8 }}>
              {s.intro}
            </T>
          ) : null}
          {s.items.map((it) => (
            <View key={it.term} style={styles.item}>
              <Marker color={it.color} shape={it.shape} />
              <View style={{ flex: 1, gap: 2 }}>
                <T style_="subheadline" weight="600">
                  {it.term}
                </T>
                <T style_="subheadline" secondary>
                  {it.def}
                </T>
              </View>
            </View>
          ))}
        </View>
      ))}
    </SheetScreen>
  );
}

function Marker({ color, shape }: { color: string; shape: 'line' | 'dot' | 'triangle' | 'area' | 'none' }) {
  if (shape === 'none') return null;
  if (shape === 'dot') return <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: color, marginTop: 4 }} />;
  if (shape === 'triangle')
    return <View style={{ width: 0, height: 0, marginTop: 4, borderLeftWidth: 6, borderRightWidth: 6, borderTopWidth: 11, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: color }} />;
  if (shape === 'area') return <View style={{ width: 14, height: 14, borderRadius: 3, backgroundColor: color, opacity: 0.5, marginTop: 3 }} />;
  return <View style={{ width: 14, height: 3, borderRadius: 2, backgroundColor: color, marginTop: 9 }} />;
}

const styles = StyleSheet.create({
  card: { borderRadius: 20, padding: 16, gap: 10 },
  item: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
});
