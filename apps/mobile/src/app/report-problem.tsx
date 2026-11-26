import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { useState } from 'react';
import { Alert, Linking, Platform, Share, TextInput } from 'react-native';
import { installLogCapture, recentLogLines } from '@/features/about/log-buffer';
import { buildMailBody, buildReport, canSubmit, ISSUES_URL, mailtoUrl, MAX_DESCRIPTION, MAX_TITLE, subjectFor, type ProblemContext, type ProblemDraft } from '@/features/about/problem-report';
import { fmtTime } from '@/features/format';
import { useSnapshot } from '@/runtime/hooks';
import { useSettings } from '@/runtime/settings-store';
import { NavRow, Row, Section, T, ToggleRow, TrioScreen, useTrioColors } from '@/trio';

installLogCapture();

function useContext_(): ProblemContext {
  const s = useSettings.getState();
  const runs = useSnapshot().loopRuns;
  return {
    appVersion: Constants.expoConfig?.version ?? '0.1.0',
    build: Constants.expoConfig?.ios?.buildNumber ?? String(Constants.expoConfig?.android?.versionCode ?? 1),
    platform: Platform.OS,
    osVersion: String(Platform.Version),
    deviceModel: Device.modelName ?? 'unknown device',
    algorithm: s.algorithmId,
    loopMode: s.loopMode,
    pump: s.pumpId,
    cgm: s.cgmId,
    units: s.units,
    recentLoops: runs.slice(-5).map((r) => `${fmtTime(r.date)} ${r.error ? `failed: ${r.error}` : 'ok'}`),
  };
}

/** Trio's ReportProblemView without a server: compose a mail or share sheet with the logs; Buddy sends nothing itself. */
export default function ReportProblemScreen() {
  const c = useTrioColors();
  const context = useContext_();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [attachLogs, setAttachLogs] = useState(true);
  const draft: ProblemDraft = { title, description, attachLogs };
  const ready = canSubmit(draft);

  const email = async () => {
    const url = mailtoUrl(subjectFor(draft, context.appVersion), buildMailBody(draft, context, recentLogLines()));
    try {
      await Linking.openURL(url);
    } catch {
      Alert.alert('No Mail App', 'No mail app is set up on this device. Use Share instead.', [{ text: 'OK', style: 'cancel' }]);
    }
  };
  const share = async () => {
    try {
      await Share.share({ title: subjectFor(draft, context.appVersion), message: buildReport(draft, context, recentLogLines()) });
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <TrioScreen back title="Report a Problem">
      <Section header="Title" footer="Optional.">
        <Row>
          <TextInput value={title} onChangeText={setTitle} maxLength={MAX_TITLE} placeholder="Short summary" placeholderTextColor={c.tertiary} selectionColor={c.tabBar} style={{ flex: 1, color: c.primary, fontSize: 17, paddingVertical: 8 }} accessibilityLabel="Title" />
        </Row>
      </Section>
      <Section header="What went wrong?" footer={`${[...description].length} / ${MAX_DESCRIPTION}`}>
        <Row>
          <TextInput
            value={description}
            onChangeText={setDescription}
            multiline
            placeholder="Describe the problem and what you expected."
            placeholderTextColor={c.tertiary}
            selectionColor={c.tabBar}
            style={{ flex: 1, minHeight: 140, color: c.primary, fontSize: 17, textAlignVertical: 'top', paddingTop: 8 }}
            accessibilityLabel="Description"
          />
        </Row>
      </Section>
      <Section footer="Buddy builds the report on this device and sends nothing. Tokens, passwords and serial numbers are removed from the logs. Glucose values can still appear in them, so read the report before you send it.">
        <ToggleRow label="Attach Logs" value={attachLogs} onChange={setAttachLogs} />
      </Section>
      <Section>
        <NavRow label="Send by Email" onPress={ready ? () => void email() : () => undefined} subtitle={ready ? undefined : 'Describe the problem first'} />
        <NavRow label="Share Report" onPress={ready ? () => void share() : () => undefined} />
      </Section>
      <Section footer="Public. Only for bugs you can describe without personal or health data.">
        <NavRow label="Open a GitHub Issue" external onPress={() => void Linking.openURL(ISSUES_URL)} />
      </Section>
      <T style_="footnote" secondary style={{ marginHorizontal: 20 }}>
        {Device.modelName ?? Platform.OS} · Buddy {context.appVersion}
      </T>
    </TrioScreen>
  );
}
