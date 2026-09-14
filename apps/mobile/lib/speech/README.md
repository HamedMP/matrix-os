# Native Mobile dictation

Native Mobile records int16 PCM with Expo SDK 57 `useAudioStream`, downmixes hardware channels to mono and packages the actual hardware sample rate as WAV, and sends it through authenticated runtime speech routes. Stop inserts the final transcription into the editable composer. Send remains a separate action. Leaving the foreground, changing account/computer/chat, or cancellation closes capture and fences late responses.

The nine rounded level bars measure actual microphone PCM and retain only nine normalized samples. Audio stays in bounded memory while recording. Upload uses a temporary cache WAV, deleted in `finally`; raw PCM is cleared after upload. A process kill may leave that OS-managed cache file until cache cleanup. No recording is intentionally saved in user documents.

## Native release requirement

`expo-audio` adds a native module. Rebuild the SDK 57 dev client for iOS and Android; Expo Go is unsupported. App version 0.2.3 changes the appVersion-based OTA runtime so this update is not delivered to older binaries missing the module. Microphone permissions already exist; the audio plugin explicitly disables background playback/recording.

Validate on both physical platforms: permission grant/denial; silence; hardware-rate WAV accepted by the gateway; stop/edit/manual-send; switching chat/computer; background during permission/capture/upload; and microphone release after cancellation. Jest tests exercise adapters and contracts, not device microphone behavior.
