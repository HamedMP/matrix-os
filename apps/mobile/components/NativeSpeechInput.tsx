import { useEffect, useMemo, useRef, useState } from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { AppState, Pressable, Text, View } from 'react-native';
import { requestRecordingPermissionsAsync, useAudioStream, type AudioStreamBuffer } from 'expo-audio';
import { usePlatformSpeechDraft } from '@matrix-os/ui/speech';
import { createNativeSpeechCapture, type NativeSpeechRecording } from '@/lib/speech/capture';
import { createNativeSpeechClient } from '@/lib/speech/client';

export function NativeSpeechInput(props: {
  scopeKey: string; baseUrl: string; runtimeSlot: string;
  getToken(): Promise<string | null>;
  onDraft(text: string): void;
  onActive(active: boolean): void;
}) {
  const { theme } = useUnistyles();
  const bufferListener = useRef<((buffer: AudioStreamBuffer) => void) | null>(null);
  const { stream } = useAudioStream({ sampleRate: 16000, channels: 1, encoding: 'int16', onBuffer: buffer => bufferListener.current?.(buffer) });
  const client = useMemo(() => createNativeSpeechClient(props), [props.scopeKey]);
  const adapter = useMemo(() => createNativeSpeechCapture({
    start: () => stream.start(), stop: () => stream.stop(),
    subscribe: callback => { bufferListener.current = callback; return { remove: () => { if (bufferListener.current === callback) bufferListener.current = null; } }; },
  }, requestRecordingPermissionsAsync), [stream]);
  const speech = usePlatformSpeechDraft<NativeSpeechRecording>({
    scopeKey: props.scopeKey, client, captureAdapter: adapter, onDraft: props.onDraft,
    requestIdFactory: () => `sp_${Date.now()}_${Math.random().toString(36).slice(2).padEnd(12, '0')}_${Math.random().toString(36).slice(2).padEnd(12, '0')}`,
  });
  const cancel = useRef(speech.cancel); cancel.current = speech.cancel;
  const active = ['requesting_permission', 'recording', 'transcribing'].includes(speech.phase);
  useEffect(() => { props.onActive(active); }, [active, props.onActive]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') cancel.current();
    });
    return () => { subscription.remove(); props.onActive(false); };
  }, []);
  const [levels, setLevels] = useState<number[]>(Array(9).fill(0));
  useEffect(() => { setLevels(old => speech.phase === 'recording' ? [...old.slice(1), speech.inputLevel] : Array(9).fill(0)); }, [speech.inputLevel, speech.inputLevelSequence, speech.phase]);
  if (!speech.isSupported && !active && !speech.error) return null;
  const label = speech.phase === 'recording' ? 'Stop recording'
    : active ? 'Cancel transcription' : 'Record message';
  return <View style={{ gap: 6, paddingVertical: 4 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={label}
        onPress={() => {
          if (speech.phase === 'recording') speech.stop();
          else if (active) speech.cancel();
          else void speech.start();
        }} style={{ minHeight: 44, paddingHorizontal: 12, justifyContent: 'center' }}>
        <Text style={{ color: theme.v2.appColors.ink }}>{label}</Text>
      </Pressable>
      {speech.phase === 'recording' && <>
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ height: 20, flexDirection: 'row', alignItems: 'center', gap: 2 }}>
          {levels.map((level, index) => <View key={index} style={{ width: 2, height: 3 + Math.round(level * 17), opacity: 0.45 + level * 0.55, borderRadius: 999, backgroundColor: theme.v2.appColors.ink }} />)}
        </View>
        <Text style={{ color: theme.v2.appColors.ink }}>{Math.floor(speech.elapsedMs / 1000)}s</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Cancel recording" onPress={speech.cancel}><Text style={{ color: theme.v2.appColors.ink }}>Cancel</Text></Pressable>
      </>}
      {speech.phase === 'transcribing' && <Text style={{ color: theme.v2.appColors.ink }} accessibilityLiveRegion="polite">Transcribing…</Text>}
    </View>
    {speech.error && <Text style={{ color: theme.v2.appColors.ink }} accessibilityRole="alert">{speech.error}</Text>}
  </View>;
}
