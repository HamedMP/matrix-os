export interface MessagingResourceSnapshot {
  vcpu: number;
  memoryGiB: number;
  diskGiB: number;
}

export interface MessagingResourceFloor {
  vcpu: number;
  memoryGiB: number;
  diskGiB: number;
}

export const DEFAULT_MESSAGING_RESOURCE_FLOOR: MessagingResourceFloor = {
  vcpu: 2,
  memoryGiB: 4,
  diskGiB: 40,
};

export const SYNAPSE_MESSAGING_RESOURCE_FLOOR: MessagingResourceFloor = {
  vcpu: 2,
  memoryGiB: 6,
  diskGiB: 60,
};

export function meetsMessagingResourceFloor(
  resources: MessagingResourceSnapshot,
  floor: MessagingResourceFloor = DEFAULT_MESSAGING_RESOURCE_FLOOR,
): boolean {
  return (
    resources.vcpu >= floor.vcpu &&
    resources.memoryGiB >= floor.memoryGiB &&
    resources.diskGiB >= floor.diskGiB
  );
}
