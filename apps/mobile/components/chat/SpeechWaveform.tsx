import { useState } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

// The same nine bars, 3 to 20pt tall, as the web app's recording waveform.
const BAR_COUNT = 9;
const MIN_BAR_HEIGHT = 3;
const MAX_BAR_HEIGHT = 20;

function clampLevel(level: number): number {
  return Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
}

export interface SpeechWaveformProps {
  /** The microphone's loudness now, 0 to 1. */
  level: number;
  /** Counts readings, so a reading equal to the last still moves the bars along. */
  sampleSequence: number;
}

interface Reading {
  /** Counts up with every reading, so a bar keeps its key as it moves left. */
  id: number;
  level: number;
}

function quietReadings(): Reading[] {
  return Array.from({ length: BAR_COUNT }, (_, slot) => ({ id: slot - BAR_COUNT, level: 0 }));
}

/** The last nine loudness readings, newest on the right. */
export function SpeechWaveform({ level, sampleSequence }: SpeechWaveformProps) {
  const [history, setHistory] = useState(quietReadings);
  const [seenSequence, setSeenSequence] = useState(sampleSequence);
  if (sampleSequence !== seenSequence) {
    setSeenSequence(sampleSequence);
    setHistory((current) => [...current.slice(1), { id: (current.at(-1)?.id ?? 0) + 1, level: clampLevel(level) }]);
  }

  return (
    <View testID="speech-waveform" style={styles.waveform} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {history.map((reading) => (
        <View
          key={reading.id}
          testID="speech-waveform-bar"
          style={[
            styles.bar,
            {
              height: MIN_BAR_HEIGHT + Math.round(reading.level * (MAX_BAR_HEIGHT - MIN_BAR_HEIGHT)),
              opacity: 0.45 + reading.level * 0.55,
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  waveform: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    height: MAX_BAR_HEIGHT,
  },
  bar: {
    width: 3,
    borderRadius: theme.v2.radius.full,
    backgroundColor: theme.v2.colors.danger,
  },
}));
