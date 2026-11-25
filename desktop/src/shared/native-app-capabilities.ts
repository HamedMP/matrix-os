/** One capability contract shared by all trusted app hosts. */
export {
  APP_CAPABILITY_CHANNEL,
  AppCapabilityInputSchema,
  createAppCapabilityClient as createNativeAppCapabilityClient,
  settleAppCapabilityClient,
  type AppCapabilityInput,
} from "@matrix-os/contracts";
