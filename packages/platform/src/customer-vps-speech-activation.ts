import type { Dispatcher } from 'undici';
import {
  iterateRunningUserMachinePages,
  type PlatformDB,
  type UserMachineRecord,
} from './db.js';
import {
  activatePlatformSpeechFleet,
  type SpeechFleetActivationPageResult,
} from './speech/fleet-activation.js';

const SPEECH_ACTIVATION_PAGE_SIZE = 32;

export interface CustomerVpsSpeechActivationTarget {
  handle?: string;
  afterMachineId?: string;
}

export async function activateCustomerVpsSpeechPage(options: {
  db: PlatformDB;
  target?: CustomerVpsSpeechActivationTarget;
  platformRegisterUrl: string;
  platformSecret: string;
  fetchDispatcher?: Dispatcher;
}): Promise<SpeechFleetActivationPageResult> {
  const platformOrigin = new URL(options.platformRegisterUrl).origin;
  // One request handles at most one concurrent wave. Even if every gateway
  // status probe reaches its 10-second timeout, the response remains inside
  // the release workflow's 180-second request deadline.
  const pages = iterateRunningUserMachinePages(options.db, SPEECH_ACTIVATION_PAGE_SIZE, {
    ...(options.target?.handle ? { handle: options.target.handle } : {}),
    ...(options.target?.afterMachineId
      ? { afterMachineId: options.target.afterMachineId }
      : {}),
    provisioningClass: 'customer',
    activationState: 'authorized',
  });
  const firstPage = await pages.next();
  await pages.return(undefined);
  const machines: UserMachineRecord[] = firstPage.done ? [] : firstPage.value;
  const result = await activatePlatformSpeechFleet({
    machines: machines.map((machine) => ({
      machineId: machine.machineId,
      clerkUserId: machine.clerkUserId,
      handle: machine.handle,
      runtimeSlot: machine.runtimeSlot,
      runtimeTokenEpoch: machine.runtimeTokenEpoch,
      publicIPv4: machine.publicIPv4,
    })),
    platformOrigin,
    platformSecret: options.platformSecret,
    fetchDispatcher: options.fetchDispatcher,
    concurrency: SPEECH_ACTIVATION_PAGE_SIZE,
  });
  const complete = options.target?.handle !== undefined
    || machines.length < SPEECH_ACTIVATION_PAGE_SIZE;
  return {
    ...result,
    complete,
    nextCursor: complete ? null : machines.at(-1)!.machineId,
  };
}
