import XCTest
import MatrixSyncSupport

final class WebShellURLTests: XCTestCase {
    func testWebShellURLUsesSessionRoutedAppShell() {
        XCTAssertEqual(MatrixSyncURLs.webShell.absoluteString, "https://app.matrix-os.com")
    }
}
