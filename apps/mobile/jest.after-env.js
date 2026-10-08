// RNTL must first load after Jest installs afterEach/beforeAll/afterAll. Loading
// it in setupFiles silently disables its automatic tree/effect cleanup.
const { configure } = require("@testing-library/react-native");
const { mobileQueryClient } = require("./lib/query-client");
const { disposeTestQueryClient } = require("./__tests__/query-test-cleanup");

// Decorative/loading elements remain queryable by testID in screen tests.
configure({ defaultIncludeHiddenElements: true });

afterEach(async () => {
  // RNTL's earlier cleanup unmounts observers; dispose their shared cache and
  // its GC timers afterward rather than keeping the test process alive.
  await disposeTestQueryClient(mobileQueryClient);
});
