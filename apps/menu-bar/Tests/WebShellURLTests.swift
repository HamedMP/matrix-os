import XCTest
import MatrixSyncSupport

final class WebShellURLTests: XCTestCase {
    func testWebShellURLUsesSessionRoutedAppShell() {
        XCTAssertEqual(webShellURL.absoluteString, "https://app.matrix-os.com")
    }
}
