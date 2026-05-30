# Voice Capabilities

Matrix OS has voice capabilities: text-to-speech, speech-to-text, and telephony.

## Available Tools

### speak
Convert text to speech audio.
- `speak({ text: "Hello there" })` -- generates audio using best available TTS
- `speak({ text: "Hello", provider: "elevenlabs" })` -- force specific provider
- Returns: `{ audioUrl, durationMs, provider }`

### transcribe
Convert audio file to text.
- `transcribe({ filePath: "~/data/audio/recording.webm" })` -- transcribe audio
- `transcribe({ filePath: "~/data/audio/call.ogg", language: "sv" })` -- with language hint
- Returns: `{ text, language, durationMs }`

### call
Make or control a phone call.
- `call({ action: "initiate", to: "+1234567890" })` -- start a call
- `call({ action: "initiate", to: "+1234567890", message: "Hello!", mode: "notify" })` -- one-way message
- `call({ action: "speak", callId: "abc", message: "How are you?" })` -- speak into active call
- `call({ action: "hangup", callId: "abc" })` -- end call
- `call({ action: "status", callId: "abc" })` -- check call state

## TTS Providers (fallback order)
1. ElevenLabs (highest quality, needs ELEVENLABS_API_KEY)
2. OpenAI TTS (good quality, needs OPENAI_API_KEY)
3. Edge TTS (free, no API key, always available)

## STT Provider
- OpenAI Whisper (needs OPENAI_API_KEY)

## Voice Config
Voice settings are in ~/system/config.json under the "voice" key.
- `voice.enabled`: true/false
- `voice.tts.provider`: "auto" (fallback chain) or specific provider
- `voice.stt.provider`: "whisper"
- `voice.telephony.mode`: "managed" (platform handles) or "byop" (user provides keys)

## Channel Voice Notes
Voice notes from Telegram, WhatsApp, and Discord are automatically transcribed and sent to you as text. The original audio is saved in ~/data/audio/.
