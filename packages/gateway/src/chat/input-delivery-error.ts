/** Only throw before an answer can have reached a native process or queue. */
export class ChatInputNotDeliveredError extends Error {
  constructor() { super("Input was not delivered"); this.name = "ChatInputNotDeliveredError"; }
}
