import { collaborationTest as test, expect } from "../fixtures/collaboration.js";

test("guarded identities sign in and satisfy the collaboration preview preconditions", async ({ collaborationJourney }) => {
  const { actors, config, previewUrl } = collaborationJourney;
  expect(previewUrl).toBe(`${config.baseUrl}/vm/${config.previewHandle}`);
  expect(actors.owner.preconditions.computers.some((computer) => computer.handle === config.previewHandle)).toBe(true);
  expect(actors.member.preconditions.computers).toHaveLength(0);
  expect(actors.outsider.preconditions.computers).toHaveLength(0);
  expect(actors.guest.preconditions.computers).toHaveLength(0);
});
