export function targetRuntimeTokenEpoch(currentEpoch, action, hostEpoch) {
  if (!Number.isSafeInteger(currentEpoch) || currentEpoch < 1 || currentEpoch > 2147483647) {
    throw new Error('Invalid database epoch');
  }
  if (action === 'prepare') {
    if (currentEpoch === 2147483647) throw new Error('Epoch limit reached');
    return currentEpoch + 1;
  }
  if (action === 'prepare-recovery' && Number.isSafeInteger(hostEpoch) &&
      hostEpoch >= 1 && hostEpoch + 1 === currentEpoch) {
    return currentEpoch;
  }
  throw new Error('Host epoch does not match database rotation state');
}
