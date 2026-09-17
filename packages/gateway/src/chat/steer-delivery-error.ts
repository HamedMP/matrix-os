/** The provider guarantees that this correction has not reached native execution. */
export class ChatSteerNotDeliveredError extends Error {
  constructor() { super("Steering was not delivered"); this.name = "ChatSteerNotDeliveredError"; }
}
