import { readFileSync } from 'node:fs';

// Shared immutable source data; privileged installation uses isolated system Python.
const files = JSON.parse(readFileSync(new URL('./native-experience.json', import.meta.url), 'utf8'));
export const renderNativeExperience = () => ({ ...files });
