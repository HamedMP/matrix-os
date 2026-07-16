#if os(macOS)
import AppKit
import SwiftUI
import DesignSystem

struct FileOpenPalette: View {
    @ObservedObject var model: AppModel
    @State private var selection = 0
    @FocusState private var fieldFocused: Bool

    private var results: [WorkspaceFileSearchItem] {
        model.fileOpenSearchResults
    }

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.opacity(0.35)
                .ignoresSafeArea()
                .onTapGesture { close() }

            palette
                .padding(.top, 96)
        }
        .onAppear {
            fieldFocused = true
            selection = 0
            model.refreshFileOpenIndex()
        }
        .onChange(of: model.fileOpenQuery) { _, _ in selection = 0 }
        .onChange(of: results.count) { _, count in
            if count == 0 {
                selection = 0
            } else if selection >= count {
                selection = count - 1
            }
        }
        .background(
            FileOpenKeyCatcher(
                onUp: { moveSelection(-1) },
                onDown: { moveSelection(1) },
                onReturn: openSelected,
                onEscape: close
            )
        )
    }

    private var palette: some View {
        VStack(spacing: 0) {
            searchField
            Rectangle().fill(Color.hairlineDark).frame(height: 1)
            resultList
        }
        .frame(width: 680)
        .background(
            RoundedRectangle(cornerRadius: Radius.panel, style: .continuous)
                .fill(Color.surfaceCard)
                .overlay(
                    RoundedRectangle(cornerRadius: Radius.panel, style: .continuous)
                        .strokeBorder(Color.hairlineHighlight, lineWidth: 1)
                )
        )
        .clipShape(RoundedRectangle(cornerRadius: Radius.panel, style: .continuous))
        .shadow(color: .black.opacity(0.5), radius: 30, y: 12)
    }

    private var searchField: some View {
        HStack(spacing: Spacing.x3) {
            Image(systemName: "doc.text.magnifyingglass")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Color.signalLive)
            TextField("Open file in current task…", text: $model.fileOpenQuery)
                .textFieldStyle(.plain)
                .font(.plexSans(15))
                .foregroundStyle(Color.inkPrimary)
                .focused($fieldFocused)
                .onSubmit(openSelected)
            if model.isIndexingFiles {
                ProgressView()
                    .controlSize(.small)
            }
        }
        .padding(.horizontal, Spacing.x4)
        .padding(.vertical, Spacing.x4)
    }

    @ViewBuilder
    private var resultList: some View {
        if results.isEmpty {
            VStack(alignment: .leading, spacing: Spacing.x1) {
                Text(model.isIndexingFiles ? "Indexing files…" : "No matching files")
                    .font(.plexSans(13, weight: .semibold))
                    .foregroundStyle(Color.inkSecondary)
                Text("Search is scoped to projects/\(model.projectSlug).")
                    .font(.plexSans(12))
                    .foregroundStyle(Color.inkTertiary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Spacing.x4)
        } else {
            ScrollView {
                LazyVStack(spacing: 2) {
                    ForEach(Array(results.enumerated()), id: \.element.id) { index, item in
                        row(item, active: index == selection)
                            .onTapGesture { open(item) }
                            .onHover { if $0 { selection = index } }
                    }
                }
                .padding(Spacing.x2)
            }
            .frame(maxHeight: 390)
        }
    }

    private func row(_ item: WorkspaceFileSearchItem, active: Bool) -> some View {
        HStack(spacing: Spacing.x3) {
            Image(systemName: iconName(for: item.name))
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(active ? Color.signalLive : Color.inkTertiary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name)
                    .font(.plexSans(14, weight: .semibold))
                    .foregroundStyle(Color.inkPrimary)
                Text(item.directory)
                    .font(.plexMono(11))
                    .foregroundStyle(Color.inkTertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Spacing.x3)
        .padding(.vertical, Spacing.x2)
        .background(
            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                .fill(active ? Color.surfaceCardRaised : Color.clear)
        )
        .contentShape(Rectangle())
    }

    private func moveSelection(_ delta: Int) {
        let count = results.count
        guard count > 0 else { return }
        selection = (selection + delta + count) % count
    }

    private func openSelected() {
        guard results.indices.contains(selection) else { return }
        open(results[selection])
    }

    private func open(_ item: WorkspaceFileSearchItem) {
        model.openFileFromSearch(item)
    }

    private func close() {
        model.hideFileOpenSearch()
    }

    private func iconName(for name: String) -> String {
        switch URL(fileURLWithPath: name).pathExtension.lowercased() {
        case "swift": return "swift"
        case "md", "markdown": return "doc.richtext"
        case "json", "yml", "yaml", "toml": return "curlybraces"
        case "js", "jsx", "ts", "tsx": return "chevron.left.forwardslash.chevron.right"
        default: return "doc.text"
        }
    }
}

private struct FileOpenKeyCatcher: NSViewRepresentable {
    let onUp: () -> Void
    let onDown: () -> Void
    let onReturn: () -> Void
    let onEscape: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onUp: onUp, onDown: onDown, onReturn: onReturn, onEscape: onEscape)
    }

    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: .zero)
        context.coordinator.install()
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        context.coordinator.onUp = onUp
        context.coordinator.onDown = onDown
        context.coordinator.onReturn = onReturn
        context.coordinator.onEscape = onEscape
    }

    static func dismantleNSView(_ nsView: NSView, coordinator: Coordinator) {
        coordinator.uninstall()
    }

    final class Coordinator {
        var onUp: () -> Void
        var onDown: () -> Void
        var onReturn: () -> Void
        var onEscape: () -> Void
        private var monitor: Any?

        init(onUp: @escaping () -> Void, onDown: @escaping () -> Void, onReturn: @escaping () -> Void, onEscape: @escaping () -> Void) {
            self.onUp = onUp
            self.onDown = onDown
            self.onReturn = onReturn
            self.onEscape = onEscape
        }

        func install() {
            guard monitor == nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self else { return event }
                let searchFieldHasFocus = MainActor.assumeIsolated {
                    Self.paletteSearchFieldHasFocus()
                }
                guard searchFieldHasFocus else { return event }
                switch event.keyCode {
                case 125:
                    onDown()
                    return nil
                case 126:
                    onUp()
                    return nil
                case 36, 76:
                    onReturn()
                    return nil
                case 53:
                    onEscape()
                    return nil
                default:
                    return event
                }
            }
        }

        @MainActor
        private static func paletteSearchFieldHasFocus() -> Bool {
            guard let responder = NSApp.keyWindow?.firstResponder else { return false }
            return responder is NSTextView
        }

        func uninstall() {
            if let monitor {
                NSEvent.removeMonitor(monitor)
            }
            monitor = nil
        }
    }
}
#endif
