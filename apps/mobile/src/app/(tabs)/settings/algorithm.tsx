import { NavRow, PickerRow, Section } from '@/trio';
import { algorithms, algorithmSettingsFor, runLoop } from '@/runtime/runtime';
import { useSettings } from '@/runtime/settings-store';
import { SchemaForm } from '@/features/settings/components/schema-form';
import { SettingsScreen, go } from '@/features/settings/components/settings-screen';
import { isOref } from '@/features/settings/bindings';

/** Port of AlgorithmSettings, plus Buddy's algorithm choice (its plugin extensibility). */
export default function AlgorithmSettings() {
  const algorithmId = useSettings((s) => s.algorithmId);
  const update = useSettings((s) => s.update);
  const setAlgorithmSettings = useSettings((s) => s.setAlgorithmSettings);
  useSettings((s) => s.algorithmSettings);
  const list = algorithms.list();
  const active = algorithms.get(algorithmId) ?? algorithms.require('oref-smb');
  const values = algorithmSettingsFor(active);

  const choose = (id: string) => {
    if (id === algorithmId) return;
    update({ algorithmId: id });
    void runLoop();
  };

  return (
    <SettingsScreen title="Algorithm Settings">
      {isOref(active.meta.id) ? (
        <Section header="Oref Algorithm">
          <NavRow label="Autosens" onPress={() => go('/settings/algorithm-autosens')} />
          <NavRow label="Super Micro Bolus (SMB)" onPress={() => go('/settings/algorithm-smb')} />
          <NavRow label="Dynamic Settings" onPress={() => go('/settings/algorithm-dynamic')} />
          <NavRow label="Target Behavior" onPress={() => go('/settings/algorithm-target-behavior')} />
          <NavRow label="Additionals" onPress={() => go('/settings/algorithm-additionals')} />
        </Section>
      ) : null}
      <Section header="Algorithm" footer={`${active.meta.description}${active.meta.maturity === 'experimental' ? ' Experimental.' : ''} By ${active.meta.author}.`}>
        <PickerRow label="Algorithm" value={active.meta.id} options={list.map((a) => ({ value: a.meta.id, label: a.meta.name }))} onChange={choose} />
      </Section>
      {isOref(active.meta.id) ? null : (
        <SchemaForm sections={active.settings} values={values} onChange={(k, v) => setAlgorithmSettings(active.meta.id, { ...values, [k]: v })} />
      )}
    </SettingsScreen>
  );
}
