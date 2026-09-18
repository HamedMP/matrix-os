import { DeviceEventEmitter } from "react-native";

const DISCOVERY_CHANGED = "matrix:collaboration-discovery-changed";

export function notifyCollaborationDiscoveryChanged(): void {
  DeviceEventEmitter.emit(DISCOVERY_CHANGED);
}

export function subscribeCollaborationDiscoveryChanged(listener: () => void): () => void {
  const subscription = DeviceEventEmitter.addListener(DISCOVERY_CHANGED, listener);
  return () => subscription.remove();
}
