import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { requestRecordingPermissionsAsync, useAudioStream, type AudioStreamBuffer } from 'expo-audio';
import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon';
import Mic01Icon from '@hugeicons/core-free-icons/Mic01Icon';
import StopIcon from '@hugeicons/core-free-icons/StopIcon';
import { usePlatformSpeechDraft } from '@matrix-os/ui/speech';
import { IconButton } from '@/components/ui';
import { createNativeSpeechCapture, type NativeSpeechRecording } from '@/lib/speech/capture';
import { createNativeSpeechClient } from '@/lib/speech/client';

function nativeSpeechRequestId(): string {
  const entropy = new Uint8Array(12);
  globalThis.crypto.getRandomValues(entropy);
  return `sp_${Date.now()}_${Array.from(entropy, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function NativeSpeechInput(props: {
  scopeKey: string;
  baseUrl: string;
  runtimeSlot: string;
  getToken(): Promise<string | null>;
  getDraftRevision(): number;
  onDraft(text: string, recordingRevision: number): void | string;
  onActive(active: boolean): void;
}) {
  const { theme } = useUnistyles();
  const bufferListener = useRef<((buffer: AudioStreamBuffer) => void) | null>(null);
  const recordingRevision = useRef(0);
  const commitDraft = useRef(props.onDraft);
  commitDraft.current = props.onDraft;
  const { stream } = useAudioStream({ sampleRate: 16000, channels: 1, encoding: 'int16', onBuffer: buffer => bufferListener.current?.(buffer) });
  const client = useMemo(() => createNativeSpeechClient(props), [props.scopeKey]);
  const adapter = useMemo(() => createNativeSpeechCapture({
    start: () => stream.start(), stop: () => stream.stop(),
    subscribe: callback => { bufferListener.current = callback; return { remove: () => { if (bufferListener.current === callback) bufferListener.current = null; } }; },
  }, requestRecordingPermissionsAsync), [stream]);
  const onDraft = useCallback((text: string) => commitDraft.current(text, recordingRevision.current), []);
  const speech = usePlatformSpeechDraft<NativeSpeechRecording>({
    scopeKey: props.scopeKey,
    client,
    captureAdapter: adapter,
    onDraft,
    requestIdFactory: nativeSpeechRequestId,
  });
  const cancel = useRef(speech.cancel);
  const phase = useRef(speech.phase);
  cancel.current = speech.cancel;
  phase.current = speech.phase;
  const active = ['requesting_permission', 'recording', 'transcribing'].includes(speech.phase);
  useEffect(() => { props.onActive(active); }, [active, props.onActive]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'background' || (state === 'inactive' && phase.current !== 'requesting_permission')) cancel.current();
    });
    return () => { subscription.remove(); props.onActive(false); };
  }, []);
  const [levels, setLevels] = useState<number[]>(Array(9).fill(0));
  useEffect(() => {
    setLevels(old => speech.phase === 'recording' ? [...old.slice(1), speech.inputLevel] : Array(9).fill(0));
  }, [speech.inputLevel, speech.inputLevelSequence, speech.phase]);

  const start = () => {
    recordingRevision.current = props.getDraftRevision();
    void speech.start();
  };
  const commonButton = { buttonSize: 44, iconSize: 21 } as const;

  if (speech.phase === 'loading') {
    return <IconButton {...commonButton} accessibilityLabel="Checking speech input" icon={Mic01Icon} loading disabled />;
  }
  if (speech.phase === 'unavailable') {
    return <IconButton {...commonButton} accessibilityLabel="Speech input unavailable" accessibilityHint="Speech input is not enabled for this computer" icon={Mic01Icon} iconColor={theme.v2.appColors.muted} disabled />;
  }
  if (speech.phase === 'requesting_permission') {
    return <IconButton {...commonButton} accessibilityLabel="Requesting microphone permission" icon={Mic01Icon} loading disabled />;
  }
  if (speech.phase === 'recording') {
    return <View style={{ minHeight: 44, flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <IconButton {...commonButton} accessibilityLabel="Cancel recording" icon={Cancel01Icon} iconColor={theme.v2.appColors.muted} onPress={speech.cancel} />
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ height: 24, flex: 1, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 3 }}>
        {levels.map((level, index) => <View key={index} style={{ width: 3, height: 4 + Math.round(level * 20), opacity: 0.48 + level * 0.52, borderRadius: 999, backgroundColor: theme.v2.appColors.blue }} />)}
      </View>
      <Text accessibilityLabel={`${Math.floor(speech.elapsedMs / 1000)} seconds recorded`} style={{ minWidth: 28, color: theme.v2.appColors.muted }}>{Math.floor(speech.elapsedMs / 1000)}s</Text>
      <IconButton {...commonButton} accessibilityLabel="Stop recording" icon={StopIcon} iconSize={17} iconColor={theme.v2.appColors.surface} backgroundColor={theme.v2.appColors.blue} borderRadius={22} onPress={speech.stop} />
    </View>;
  }
  if (speech.phase === 'transcribing') {
    return <View style={{ minHeight: 44, flex: 1, flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 8 }}>
      <Text accessibilityLiveRegion="polite" style={{ color: theme.v2.appColors.muted }}>Transcribing…</Text>
      <IconButton {...commonButton} accessibilityLabel="Cancel transcription" icon={Cancel01Icon} iconColor={theme.v2.appColors.muted} onPress={speech.cancel} />
    </View>;
  }
  return <View style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
    {speech.error ? <Text accessibilityRole="alert" numberOfLines={1} style={{ maxWidth: 150, color: theme.v2.appColors.danger }}>{speech.error}</Text> : null}
    <IconButton {...commonButton} accessibilityLabel={speech.error ? 'Try speech input again' : 'Record message'} icon={Mic01Icon} iconColor={speech.error ? theme.v2.appColors.danger : theme.v2.appColors.ink} onPress={start} />
  </View>;
}
