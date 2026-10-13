// The contracts barrel pulls in ESM-only micromark, which Jest cannot load.
jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

// These components are drawn from what they are given, in the design preview
// and in tests that have no account. Loading the sign-in library with them
// opens a message port that keeps a test run from ever exiting, so whatever
// needs the account is handed to them by a screen instead.
describe("chat components drawn from what they are given", () => {
  it.each([
    "../components/chat/Composer",
    "../components/chat/MessageList",
    "../components/chat/ChatScreenView",
    "../components/agents/AgentChatScreen",
  ])("%s loads without the sign-in library", (modulePath) => {
    jest.isolateModules(() => {
      jest.doMock("@clerk/clerk-expo", () => {
        throw new Error("@clerk/clerk-expo was loaded");
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      expect(() => require(modulePath)).not.toThrow();
    });
  });

  it("would be told apart from a component that does read the account", () => {
    jest.isolateModules(() => {
      jest.doMock("@clerk/clerk-expo", () => {
        throw new Error("@clerk/clerk-expo was loaded");
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      expect(() => require("../components/chat/ComputerPhoto")).toThrow("@clerk/clerk-expo was loaded");
    });
  });
});
