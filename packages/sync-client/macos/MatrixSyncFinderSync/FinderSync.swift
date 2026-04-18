import Cocoa
import FinderSync

// Badge identifiers. Registered once in setupBadges(); Finder caches them
// by id, so changing the icon shape means bumping the id too.
private enum Badge {
    static let synced = "synced"
    static let pending = "pending"
    static let error = "error"
}

// Mirror of the daemon's sync-state.json entries. We only need to know if
// each file is committed (lastSyncedHash present + matches hash) to decide
// the badge. Using Decodable means the JSON payload can grow without
// breaking this extension.
private struct FileEntry: Decodable {
    let hash: String?
    let lastSyncedHash: String?
}

private struct SyncState: Decodable {
    let files: [String: FileEntry]
}

class FinderSync: FIFinderSync {
    // Path we watch. Read once from the user's config so multiple daemons
    // (different syncPath values) each get their own badges when their
    // respective extension target is installed.
    private let syncRoot: URL
    private let stateURL: URL
    private var stateCache: SyncState?
    private var lastLoadedAt: Date = .distantPast
    // Throttle state reloads -- Finder asks for badges per visible icon on
    // every folder refresh. Re-parsing the JSON hundreds of times per second
    // would melt the CPU. 500ms is imperceptible to users.
    private let reloadInterval: TimeInterval = 0.5

    override init() {
        let home = FileManager.default.homeDirectoryForCurrentUser
        self.stateURL = home.appendingPathComponent(".matrixos/sync-state.json")

        // Fall back to ~/matrixos-mirror when config isn't readable. This is
        // a best-effort default that matches `defaultSyncPath()` in the TS
        // code -- if the user moved their sync folder, they can re-pin.
        let configURL = home.appendingPathComponent(".matrixos/config.json")
        if let data = try? Data(contentsOf: configURL),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let path = json["syncPath"] as? String {
            self.syncRoot = URL(fileURLWithPath: path)
        } else {
            self.syncRoot = home.appendingPathComponent("matrixos-mirror")
        }

        super.init()

        FIFinderSyncController.default().directoryURLs = [self.syncRoot]
        setupBadges()
        startWatchingStateFile()
    }

    // MARK: - Badge registration

    private func setupBadges() {
        let controller = FIFinderSyncController.default()
        // SF Symbols can't render into NSImage at the size Finder wants for
        // badges, so we draw compact primitives by hand. Small enough to sit
        // in the corner of a file icon.
        controller.setBadgeImage(
            drawBadge(color: .systemGreen, glyph: "✓"),
            label: "Synced",
            forBadgeIdentifier: Badge.synced,
        )
        controller.setBadgeImage(
            drawBadge(color: .systemBlue, glyph: "↑"),
            label: "Syncing",
            forBadgeIdentifier: Badge.pending,
        )
        controller.setBadgeImage(
            drawBadge(color: .systemRed, glyph: "!"),
            label: "Sync error",
            forBadgeIdentifier: Badge.error,
        )
    }

    // NSImage programmatic badge -- circle fill + single glyph. Finder renders
    // these at ~16pt in the lower-right of each file icon.
    private func drawBadge(color: NSColor, glyph: String) -> NSImage {
        let size = NSSize(width: 16, height: 16)
        let image = NSImage(size: size)
        image.lockFocus()
        color.setFill()
        let rect = NSRect(origin: .zero, size: size)
        NSBezierPath(ovalIn: rect.insetBy(dx: 1, dy: 1)).fill()
        let attrs: [NSAttributedString.Key: Any] = [
            .foregroundColor: NSColor.white,
            .font: NSFont.boldSystemFont(ofSize: 10),
        ]
        let s = NSAttributedString(string: glyph, attributes: attrs)
        let stringSize = s.size()
        s.draw(at: NSPoint(
            x: (size.width - stringSize.width) / 2,
            y: (size.height - stringSize.height) / 2 - 0.5,
        ))
        image.unlockFocus()
        return image
    }

    // MARK: - State tracking

    // Watch sync-state.json with a DispatchSource so Finder sees fresh
    // badges within ~500ms of the daemon writing. Plain NSFilePresenter is
    // flakier for single-file mutations and doesn't survive atomic renames
    // that pino + writeFileAtomic can produce.
    private var stateFd: Int32 = -1
    private var stateSource: DispatchSourceFileSystemObject?

    private func startWatchingStateFile() {
        reloadState(force: true)

        // Opening the file may fail if the daemon hasn't created it yet; we
        // retry via a 2s timer until it shows up.
        let path = stateURL.path
        func tryOpen() {
            let fd = open(path, O_EVTONLY)
            if fd < 0 {
                DispatchQueue.global().asyncAfter(deadline: .now() + 2) { tryOpen() }
                return
            }
            self.stateFd = fd
            let src = DispatchSource.makeFileSystemObjectSource(
                fileDescriptor: fd,
                eventMask: [.write, .delete, .rename, .extend],
                queue: .global(qos: .utility),
            )
            src.setEventHandler { [weak self] in
                self?.reloadState(force: true)
                // On rename/delete, the old fd no longer points at anything
                // useful. Re-open after a short delay to latch onto the new
                // file.
                src.cancel()
                DispatchQueue.global().asyncAfter(deadline: .now() + 1) { tryOpen() }
            }
            src.setCancelHandler { [weak self] in
                if let fd = self?.stateFd, fd >= 0 { close(fd) }
                self?.stateFd = -1
            }
            self.stateSource = src
            src.resume()
        }
        tryOpen()
    }

    private func reloadState(force: Bool = false) {
        if !force, Date().timeIntervalSince(lastLoadedAt) < reloadInterval {
            return
        }
        lastLoadedAt = Date()
        guard let data = try? Data(contentsOf: stateURL) else {
            stateCache = nil
            return
        }
        stateCache = try? JSONDecoder().decode(SyncState.self, from: data)
        // Re-request badge redraws for everything we can see. The controller
        // API doesn't expose a "refresh all" call, but setting it again on
        // visible directories triggers a re-query.
        DispatchQueue.main.async {
            let controller = FIFinderSyncController.default()
            controller.directoryURLs = controller.directoryURLs
        }
    }

    // MARK: - FIFinderSync overrides

    override func beginObservingDirectory(at url: URL) {
        // Hook kept for symmetry with future work (e.g. kicking a pull on
        // directory view). No-op today.
    }

    override func endObservingDirectory(at url: URL) {
        // Same.
    }

    override func requestBadgeIdentifier(for url: URL) {
        // Resolve the path relative to the sync root. The daemon stores
        // remote-relative keys; in full-mirror mode (gatewayFolder == "")
        // that equals local relative. For scoped mode, the daemon writes
        // `<folder>/<rel>` as the key. We probe both.
        let rel = relativePath(from: syncRoot, to: url)
        guard let rel, !rel.isEmpty else { return }

        reloadState(force: false)
        guard let state = stateCache else {
            setBadge(Badge.pending, for: url)
            return
        }

        // Full-mirror lookup; scoped-mode lookup isn't needed here because
        // we set directoryURLs to syncRoot (which already IS the scoped
        // subtree from the daemon's point of view when gatewayFolder is set).
        let entry = state.files[rel]
        if let entry, entry.hash != nil, entry.hash == entry.lastSyncedHash {
            setBadge(Badge.synced, for: url)
        } else if entry != nil {
            setBadge(Badge.pending, for: url)
        } else {
            // Not in state yet -- could be brand new, could be ignored.
            // Omit badge to avoid noise.
        }
    }

    private func setBadge(_ id: String, for url: URL) {
        FIFinderSyncController.default().setBadgeIdentifier(id, for: url)
    }

    private func relativePath(from root: URL, to url: URL) -> String? {
        let rootPath = root.standardizedFileURL.path
        let filePath = url.standardizedFileURL.path
        guard filePath.hasPrefix(rootPath + "/") else { return nil }
        return String(filePath.dropFirst(rootPath.count + 1))
    }

    // MARK: - Menu

    override var toolbarItemName: String { "MatrixSync" }
    override var toolbarItemToolTip: String { "MatrixSync file sync status" }
    override var toolbarItemImage: NSImage {
        NSImage(systemSymbolName: "arrow.triangle.2.circlepath.circle",
                accessibilityDescription: "MatrixSync")
            ?? NSImage()
    }

    override func menu(for menuKind: FIMenuKind) -> NSMenu {
        let menu = NSMenu(title: "MatrixSync")
        menu.addItem(withTitle: "Open MatrixSync…",
                     action: #selector(openMainApp(_:)),
                     keyEquivalent: "")
        return menu
    }

    @objc private func openMainApp(_ sender: AnyObject?) {
        // Launch the host app by bundle identifier. The extension runs in a
        // sandboxed process and can't spawn arbitrary binaries.
        let bundleId = "com.matrixos.sync"
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) {
            NSWorkspace.shared.openApplication(at: url, configuration: .init())
        }
    }
}
