import Constants from 'expo-constants';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Alert, Image, Linking, Pressable, StyleSheet, TextInput, View } from 'react-native';
import type { LoopMode } from '@buddy/core';
import { CapsuleButton, GlassPanel, NavRow, PickerRow, Row, Section, T, TrioScreen, useTrioColors } from '@/trio';
import { currentAlgorithm, useRuntime } from '@/runtime/runtime';
import { useSettings } from '@/runtime/settings-store';
import { brand } from '@/features/settings/copy';
import { HintSheetProvider, useShowHint } from '@/features/settings/components/hint-sheet';
import { HintButton } from '@/features/settings/components/setting-input-section';
import { go } from '@/features/settings/components/settings-screen';
import { DOSING_MODES, DOSING_MODE_HINT, dosingModeMiniHint } from '@/features/settings/dosing-mode';
import { TRIO_CONFIG_ITEMS, filterSettingItems } from '@/features/settings/search';

const DOCS_URL = 'https://triodocs.org/';
const DISCORD_URL = 'https://discord.triodocs.org';
const FACEBOOK_URL = 'https://facebook.triodocs.org';

/** Port of Trio's Settings.RootView. */
export default function SettingsRoot() {
  const [search, setSearch] = useState('');
  return (
    <HintSheetProvider>
      <TrioScreen inlineTitle="Settings" leading={<View style={styles.balance} />} trailing={<CapsuleButton label="Trio Docs" icon="questionmark.circle" onPress={() => void Linking.openURL(DOCS_URL)} />}>
        <SearchField value={search} onChange={setSearch} />
        {search.trim() ? <SearchResults query={search} /> : <RootSections />}
      </TrioScreen>
    </HintSheetProvider>
  );
}

function SearchField({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  const c = useTrioColors();
  return (
    <GlassPanel radius={999} style={styles.search}>
      <SymbolView name="magnifyingglass" size={20} tintColor={c.secondary} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder="Search"
        placeholderTextColor={c.secondary}
        selectionColor={c.tabBar}
        autoCorrect={false}
        autoCapitalize="none"
        clearButtonMode="while-editing"
        returnKeyType="search"
        style={[styles.searchInput, { color: c.primary }]}
        accessibilityLabel="Search settings"
      />
    </GlassPanel>
  );
}

function SearchResults({ query }: { query: string }) {
  const results = filterSettingItems(query);
  return (
    <Section header="Search Results">
      {results.length > 0 ? (
        results.map((r, i) => (
          <NavRow key={`${r.item.title}-${r.matchedContent}-${i}`} label={brand(r.matchedContent)} subtitle={r.item.path?.map(brand).join(' > ')} onPress={() => go(r.item.route)} />
        ))
      ) : (
        <Row>
          <T>
            No settings matching your search query <T weight="700">»{query.trim()}«</T> found.
          </T>
        </Row>
      )}
    </Section>
  );
}

function RootSections() {
  return (
    <>
      <VersionCard />
      <DosingModeSection />
      <Section header="Buddy Configuration">
        {TRIO_CONFIG_ITEMS.map((item) => (
          <NavRow key={item.title} label={item.title} onPress={() => go(item.route)} />
        ))}
      </Section>
      <Section header="Support & Community">
        <NavRow label="Ask on Discord" external onPress={() => void Linking.openURL(DISCORD_URL)} />
        <NavRow label="Ask on Facebook" external onPress={() => void Linking.openURL(FACEBOOK_URL)} />
      </Section>
      <Section header="Buddy Backup">
        <NavRow label="Export Settings" onPress={() => go('/settings/export')} />
      </Section>
    </>
  );
}

function VersionCard() {
  const c = useTrioColors();
  const version = Constants.expoConfig?.version ?? '0.1.0';
  const build = Constants.expoConfig?.ios?.buildNumber ?? '1';
  return (
    <Section>
      <Pressable onPress={() => go('/settings/about')} accessibilityRole="button" style={({ pressed }) => [styles.version, pressed && { backgroundColor: c.fill }]}>
        <Image source={require('@/assets/images/icon.png')} style={styles.icon} accessibilityIgnoresInvertColors />
        <View style={{ flex: 1, gap: 4 }}>
          <T style_="headline">
            Buddy v{version} ({build})
          </T>
          <T style_="footnote" secondary>
            Research software, not a medical device
          </T>
        </View>
        <SymbolView name="chevron.right" size={14} tintColor={c.tertiary} weight="semibold" />
      </Pressable>
    </Section>
  );
}

function DosingModeSection() {
  const c = useTrioColors();
  const loopMode = useSettings((s) => s.loopMode);
  const update = useSettings((s) => s.update);
  const blocked = useRuntime((r) => r.closedLoopBlocked);
  const showHint = useShowHint();

  const select = (mode: LoopMode) => {
    if (mode === loopMode) return;
    if (mode === 'open') return update({ loopMode: 'open' });
    if (blocked) return Alert.alert('Closed Loop unavailable', blocked);
    Alert.alert('Enable Closed Loop?', `${currentAlgorithm().meta.name} will adjust insulin automatically within your safety limits.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Enable', onPress: () => update({ loopMode: 'closed' }) },
    ]);
  };

  return (
    <Section header="Automated Insulin Delivery">
      <View style={{ paddingTop: 12 }}>
        <PickerRow label="Dosing Mode" value={loopMode} options={DOSING_MODES} onChange={select} />
        <View style={styles.hintRow}>
          <T style_="footnote" color={blocked ? (c.dark ? c.orange : c.accent) : c.secondary} style={{ flex: 1 }}>
            {dosingModeMiniHint(loopMode, blocked)}
          </T>
          <HintButton label="Dosing Mode" onPress={() => showHint(DOSING_MODE_HINT)} />
        </View>
      </View>
    </Section>
  );
}

const styles = StyleSheet.create({
  /** Mirrors the trailing capsule so the inline title stays centred like Trio's. */
  balance: { width: 131 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 50, paddingHorizontal: 16 },
  searchInput: { flex: 1, fontSize: 17, paddingVertical: 0 },
  version: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 16 },
  icon: { width: 50, height: 50, borderRadius: 10, marginRight: 10 },
  hintRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingTop: 4, paddingBottom: 20 },
});
