import React from 'react';
import { act, create } from 'react-test-renderer';
import { AppState, type AppStateStatus } from 'react-native';
const mockCancel = jest.fn();
const mockRetryCapabilities = jest.fn();
const mockSpeech = { phase: 'idle', isSupported: true, error: null as string | null, unavailableReason: null as string | null, inputLevel: 0, inputLevelSequence: 0, elapsedMs: 0, start: jest.fn(), stop: jest.fn(), cancel: mockCancel, retryCapabilities: mockRetryCapabilities };
jest.mock('@matrix-os/ui/speech', () => ({ usePlatformSpeechDraft: () => mockSpeech }));
jest.mock('expo-audio', () => ({ useAudioStream: () => ({ stream: { start: jest.fn(), stop: jest.fn() } }), requestRecordingPermissionsAsync: jest.fn() }));
jest.mock('expo-crypto', () => ({ getRandomBytes: () => new Uint8Array(12).fill(7) }));
jest.mock('../lib/speech/client', () => ({ createNativeSpeechClient: jest.fn() }));
jest.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { v2: { colors: { textDefault: 'black' }, appColors: { ink: 'black', muted: 'gray', blue: 'blue', surface: 'white', danger: 'red' } } } }) }));
import { NativeSpeechInput } from '../components/NativeSpeechInput';

beforeEach(() => {
  jest.clearAllMocks();
  mockSpeech.phase = 'idle';
  mockSpeech.error = null;
  mockSpeech.unavailableReason = null;
});

function props() {
  return { scopeKey: 'owner:computer:chat', baseUrl: 'https://example.com', runtimeSlot: 'primary', getToken: async () => 'token', getDraftGeneration: () => 3, onDraft: jest.fn(), onActive: jest.fn() };
}

it('cancels on background and reports active capture to the composer', () => {
  let listener!: (state: AppStateStatus) => void;
  const remove = jest.fn();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_, callback) => { listener = callback; return { remove }; });
  const onActive = jest.fn();
  mockSpeech.phase = 'recording';
  let root!: ReturnType<typeof create>;
  act(() => { root = create(<NativeSpeechInput {...props()} onActive={onActive} />); });
  expect(onActive).toHaveBeenCalledWith(true);
  act(() => listener('background'));
  expect(mockCancel).toHaveBeenCalled();
  act(() => root.unmount());
  expect(remove).toHaveBeenCalled();
  expect(onActive).toHaveBeenLastCalledWith(false);
});

it('does not cancel the first-use permission request for transient iOS inactive state', () => {
  let listener!: (state: AppStateStatus) => void;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_, callback) => { listener = callback; return { remove: jest.fn() }; });
  mockSpeech.phase = 'requesting_permission';
  let root!: ReturnType<typeof create>;
  act(() => { root = create(<NativeSpeechInput {...props()} />); });

  act(() => listener('inactive'));
  expect(mockCancel).not.toHaveBeenCalled();
  act(() => listener('background'));
  expect(mockCancel).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
});

it('uses composer-sized accessible controls for idle and recording phases', () => {
  jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() });
  let root!: ReturnType<typeof create>;
  act(() => { root = create(<NativeSpeechInput {...props()} />); });
  expect(root.root.findByProps({ accessibilityLabel: 'Record message' }).props.buttonSize).toBe(44);

  mockSpeech.phase = 'recording';
  act(() => root.update(<NativeSpeechInput {...props()} />));
  expect(root.root.findByProps({ accessibilityLabel: 'Cancel recording' })).toBeTruthy();
  expect(root.root.findByProps({ accessibilityLabel: 'Stop recording' }).props.buttonSize).toBe(44);
  act(() => root.unmount());
});

it.each([
  ['loading', null, 'Checking speech input'],
  ['unavailable', null, 'Speech input unavailable'],
  ['requesting_permission', null, 'Requesting microphone permission'],
  ['transcribing', null, 'Cancel transcription'],
  ['error', 'Transcription failed', 'Try speech input again'],
])('exposes truthful accessible state for %s', (phase, error, label) => {
  jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() });
  mockSpeech.phase = phase;
  mockSpeech.error = error;
  let root!: ReturnType<typeof create>;
  act(() => { root = create(<NativeSpeechInput {...props()} />); });
  expect(root.root.findByProps({ accessibilityLabel: label })).toBeTruthy();
  act(() => root.unmount());
});

it('allows retry after a transient capability check failure', () => {
  jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() });
  mockSpeech.phase = 'unavailable';
  mockSpeech.unavailableReason = 'capability_check_failed';
  let root!: ReturnType<typeof create>;
  act(() => { root = create(<NativeSpeechInput {...props()} />); });

  act(() => root.root.findByProps({ accessibilityLabel: 'Retry speech input' }).props.onPress());

  expect(mockRetryCapabilities).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
});
