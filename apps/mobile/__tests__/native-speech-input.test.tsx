import React from 'react';
import { act, create } from 'react-test-renderer';
import { AppState, type AppStateStatus } from 'react-native';
const mockCancel = jest.fn();
const mockSpeech = { phase: 'idle', isSupported: true, error: null, inputLevel: 0, elapsedMs: 0, start: jest.fn(), stop: jest.fn(), cancel: mockCancel };
jest.mock('@matrix-os/ui/speech', () => ({ usePlatformSpeechDraft: () => mockSpeech }), { virtual: true });
jest.mock('expo-audio', () => ({ useAudioStream: () => ({ stream: { start: jest.fn(), stop: jest.fn() } }), requestRecordingPermissionsAsync: jest.fn() }));
jest.mock('../lib/speech/client', () => ({ createNativeSpeechClient: jest.fn() }));
jest.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { v2: { appColors: { ink: 'black' } } } }) }));
import { NativeSpeechInput } from '../components/NativeSpeechInput';

it('cancels on background and reports active capture to the composer', () => {
  let listener!: (state: AppStateStatus) => void;
  const remove = jest.fn();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_, callback) => { listener = callback; return { remove }; });
  const onActive = jest.fn();
  mockSpeech.phase = 'recording';
  let root!: ReturnType<typeof create>;
  act(() => { root = create(<NativeSpeechInput scopeKey="owner:computer:chat" baseUrl="https://example.com" runtimeSlot="primary" getToken={async () => 'token'} onDraft={jest.fn()} onActive={onActive} />); });
  expect(onActive).toHaveBeenCalledWith(true);
  act(() => listener('background'));
  expect(mockCancel).toHaveBeenCalled();
  act(() => root.unmount());
  expect(remove).toHaveBeenCalled();
  expect(onActive).toHaveBeenLastCalledWith(false);
});
