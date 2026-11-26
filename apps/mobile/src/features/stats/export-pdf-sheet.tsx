import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, View } from 'react-native';
import { SymbolView } from '@/trio/symbol';
import type { DataSnapshot, GlucoseUnit, TherapyProfile } from '@buddy/core';
import { useTrioPrefs } from '@/features/settings/store';
import { CapsuleButton, CheckboxRow, Row, Section, Segmented, SheetScreen, T, useTrioColors } from '@/trio';
import { INTERVALS, type Interval } from './calc';
import { buildReportHtml, isPerDayChart, orderCharts, REPORT_CATEGORIES, REPORT_CHARTS, type ReportChartType } from './pdf-report';
import { useReportStore, type ReportPreset } from './report-store';

interface Props {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly snap: DataSnapshot;
  readonly profile: TherapyProfile;
  readonly units: GlucoseUnit;
  readonly now: number;
}

/** StatExportMenuView: range, charts to include, saved presets, patient name, share the PDF. */
export function ExportPdfSheet(p: Props) {
  return (
    <Modal visible={p.visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={p.onClose}>
      {p.visible ? <Menu {...p} /> : null}
    </Modal>
  );
}

function Menu({ onClose, snap, profile, units, now }: Props) {
  const c = useTrioColors();
  const presets = useReportStore((s) => s.presets);
  const patientName = useReportStore((s) => s.patientName);
  const eA1cMmolMol = useTrioPrefs((s) => s.eA1cDisplayUnit) === 'mmolMol';
  const [range, setRange] = useState<Interval>('month');
  const [selected, setSelected] = useState<ReadonlySet<ReportChartType>>(new Set());
  const [exporting, setExporting] = useState(false);
  const charts = orderCharts(selected);
  const toggle = (t: ReportChartType) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  const changeRange = (r: Interval) => {
    setRange(r);
    // Per-day charts are disabled for the single-day range.
    if (r === 'day') setSelected((prev) => new Set([...prev].filter((t) => !isPerDayChart(t))));
  };
  const load = (preset: ReportPreset) => {
    setRange(preset.range);
    setSelected(new Set(preset.charts));
  };

  const doExport = async (name: string) => {
    useReportStore.getState().setPatientName(name);
    setExporting(true);
    try {
      const html = buildReportHtml({ snap, profile, units, now, range, charts, patientName: name.trim() || undefined, eA1cMmolMol });
      const { uri } = await Print.printToFileAsync({ html, width: 612, height: 792 });
      if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device.');
      await Sharing.shareAsync(uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: 'Buddy Statistics' });
      onClose();
    } catch (e) {
      Alert.alert('Export Failed', e instanceof Error ? e.message : String(e), [{ text: 'OK', style: 'cancel' }]);
    } finally {
      setExporting(false);
    }
  };

  const askName = () => Alert.prompt('Patient Name', 'Shown in the report header. Leave blank to omit.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Export', onPress: (t?: string) => void doExport(t ?? '') }], 'plain-text', patientName);
  const askPreset = () =>
    Alert.prompt('Save Report Preset', 'Saves the current range and chart selection for reuse.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Save',
        onPress: (t?: string) => {
          const name = (t ?? '').trim();
          if (name) useReportStore.getState().savePreset({ name, range, charts });
        },
      },
    ]);
  const askDelete = (preset: ReportPreset) =>
    Alert.alert(`Delete the report preset "${preset.name}"?`, undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => useReportStore.getState().deletePreset(preset.id) },
    ]);

  return (
    <SheetScreen
      title="Export PDF"
      leading={<CapsuleButton label="Cancel" onPress={onClose} />}
      trailing={exporting ? <ActivityIndicator color={c.accent} /> : <CapsuleButton label="Export" onPress={charts.length ? askName : () => undefined} color={charts.length ? undefined : c.secondary} />}>
      {presets.length ? (
        <Section header="Saved Reports" footer="Tap to load a preset.">
          {presets.map((preset) => (
            <Row key={preset.id} onPress={() => load(preset)} accessibilityLabel={`${preset.name}, ${preset.charts.length} charts`}>
              <View style={{ flex: 1 }}>
                <T>{preset.name}</T>
                <T style_="caption" secondary>
                  {INTERVALS.find((i) => i.value === preset.range)?.label} · {preset.charts.length === 1 ? '1 chart' : `${preset.charts.length} charts`}
                </T>
              </View>
              <Pressable onPress={() => askDelete(preset)} hitSlop={10} accessibilityRole="button" accessibilityLabel={`Delete ${preset.name}`}>
                <SymbolView name="trash.fill" size={18} tintColor={c.red} />
              </Pressable>
            </Row>
          ))}
        </Section>
      ) : null}
      <Section header="Range">
        <View style={{ padding: 12 }}>
          <Segmented options={INTERVALS} value={range} onChange={changeRange} />
        </View>
      </Section>
      {REPORT_CATEGORIES.map(({ category, label }) => (
        <Section key={category} header={label} footer={category === 'therapy' ? 'Therapy settings show the current schedule and ignore the range.' : undefined}>
          {REPORT_CHARTS.filter((r) => r.category === category).map((r) => {
            const off = range === 'day' && isPerDayChart(r.type);
            return (
              <View key={r.type} style={off ? { opacity: 0.4 } : undefined} pointerEvents={off ? 'none' : 'auto'}>
                <CheckboxRow label={r.label} value={selected.has(r.type)} onChange={() => toggle(r.type)} />
              </View>
            );
          })}
        </Section>
      ))}
      <Section>
        <Row onPress={charts.length ? askPreset : undefined} accessibilityLabel="Save as Preset">
          <T color={charts.length ? c.accent : c.secondary}>Save as Preset…</T>
        </Row>
      </Section>
    </SheetScreen>
  );
}
