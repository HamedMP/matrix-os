import AsyncStorage from "@react-native-async-storage/async-storage";

const MESSAGES_KEY = "matrix_os_cached_messages";
const QUEUE_KEY = "matrix_os_outbound_queue";
const MAX_CACHED_MESSAGES = 50;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

export interface CachedMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool?: string;
  timestamp: number;
}

export interface QueuedMessage {
  id: string;
  text: string;
  sessionId?: string;
  retries: number;
  createdAt: number;
}

export async function getCachedMessages(): Promise<CachedMessage[]> {
  const raw = await AsyncStorage.getItem(MESSAGES_KEY);
  if (!raw) return [];
  return JSON.parse(raw);
}

export async function setCachedMessages(messages: CachedMessage[]): Promise<void> {
  const trimmed = messages.slice(0, MAX_CACHED_MESSAGES);
  await AsyncStorage.setItem(MESSAGES_KEY, JSON.stringify(trimmed));
}

export async function getOutboundQueue(): Promise<QueuedMessage[]> {
  const raw = await AsyncStorage.getItem(QUEUE_KEY);
  if (!raw) return [];
  return JSON.parse(raw);
}

export async function addToOutboundQueue(msg: QueuedMessage): Promise<void> {
  const queue = await getOutboundQueue();
  queue.push(msg);
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export async function clearOutboundQueue(): Promise<void> {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([]));
}

export function getRetryDelay(retries: number): number {
  return Math.min(BASE_DELAY_MS * Math.pow(2, retries), 30000);
}

export function canRetry(msg: QueuedMessage): boolean {
  return msg.retries < MAX_RETRIES;
}
