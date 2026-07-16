#if os(macOS)
import AppKit
import SwiftUI
import DesignSystem

struct FileNavigatorOutlineView: NSViewRepresentable {
    let nodes: [WorkspaceFileTreeNode]
    let selectedPath: String?
    let onOpen: (WorkspaceFileTreeNode) -> Void
    let onToggle: (WorkspaceFileTreeNode) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onOpen: onOpen, onToggle: onToggle)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let outlineView = NSOutlineView()
        outlineView.headerView = nil
        outlineView.rowSizeStyle = .custom
        outlineView.rowHeight = 28
        outlineView.indentationPerLevel = 16
        outlineView.backgroundColor = .clear
        outlineView.appearance = NSAppearance(named: .aqua)
        outlineView.selectionHighlightStyle = .regular
        outlineView.allowsMultipleSelection = false
        outlineView.allowsEmptySelection = true

        let column = NSTableColumn(identifier: .init("file"))
        column.resizingMask = .autoresizingMask
        column.minWidth = 180
        column.width = 320
        outlineView.addTableColumn(column)
        outlineView.outlineTableColumn = column
        outlineView.delegate = context.coordinator
        outlineView.dataSource = context.coordinator
        outlineView.target = context.coordinator
        outlineView.doubleAction = #selector(Coordinator.doubleClick(_:))

        let scrollView = NSScrollView()
        scrollView.borderType = .noBorder
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.documentView = outlineView
        context.coordinator.outlineView = outlineView
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let outlineView = scrollView.documentView as? NSOutlineView else { return }
        context.coordinator.onOpen = onOpen
        context.coordinator.onToggle = onToggle
        context.coordinator.apply(nodes: nodes, selectedPath: selectedPath, to: outlineView)
    }

    @MainActor
    final class Coordinator: NSObject, NSOutlineViewDataSource, NSOutlineViewDelegate {
        var onOpen: (WorkspaceFileTreeNode) -> Void
        var onToggle: (WorkspaceFileTreeNode) -> Void
        weak var outlineView: NSOutlineView?
        private var roots: [NodeBox] = []
        private var boxesByPath: [String: NodeBox] = [:]
        private var isApplyingSnapshot = false

        init(onOpen: @escaping (WorkspaceFileTreeNode) -> Void, onToggle: @escaping (WorkspaceFileTreeNode) -> Void) {
            self.onOpen = onOpen
            self.onToggle = onToggle
        }

        func apply(nodes: [WorkspaceFileTreeNode], selectedPath: String?, to outlineView: NSOutlineView) {
            isApplyingSnapshot = true
            roots = nodes.map(NodeBox.init)
            boxesByPath = Dictionary(uniqueKeysWithValues: roots.flatMap { $0.flattened().map { ($0.node.path, $0) } })
            outlineView.reloadData()
            for box in boxesByPath.values where box.node.expanded {
                outlineView.expandItem(box)
            }
            if let selectedPath,
               let selected = boxesByPath[selectedPath] {
                let row = outlineView.row(forItem: selected)
                if row >= 0 {
                    outlineView.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
                    outlineView.scrollRowToVisible(row)
                }
            } else {
                outlineView.deselectAll(nil)
            }
            isApplyingSnapshot = false
        }

        func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
            box(for: item)?.children.count ?? roots.count
        }

        func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
            let children = box(for: item)?.children ?? roots
            return children[index]
        }

        func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool {
            box(for: item)?.node.isDirectory ?? false
        }

        func outlineView(
            _ outlineView: NSOutlineView,
            viewFor tableColumn: NSTableColumn?,
            item: Any
        ) -> NSView? {
            guard let box = box(for: item) else { return nil }
            let cell = outlineView.makeView(withIdentifier: FileCell.identifier, owner: self) as? FileCell ?? FileCell()
            cell.configure(with: box.node, isSelected: outlineView.selectedRow == outlineView.row(forItem: item))
            return cell
        }

        func outlineViewSelectionDidChange(_ notification: Notification) {
            guard !isApplyingSnapshot,
                  let outlineView,
                  outlineView.selectedRow >= 0,
                  let box = outlineView.item(atRow: outlineView.selectedRow) as? NodeBox else {
                return
            }
            outlineView.reloadData()
            if box.node.isDirectory {
                onToggle(box.node)
            } else {
                onOpen(box.node)
            }
        }

        func outlineViewItemDidExpand(_ notification: Notification) {
            guard !isApplyingSnapshot,
                  let box = notification.userInfo?["NSObject"] as? NodeBox,
                  !box.node.expanded else {
                return
            }
            onToggle(box.node)
        }

        func outlineViewItemDidCollapse(_ notification: Notification) {
            guard !isApplyingSnapshot,
                  let box = notification.userInfo?["NSObject"] as? NodeBox,
                  box.node.expanded else {
                return
            }
            onToggle(box.node)
        }

        @objc func doubleClick(_ sender: NSOutlineView) {
            guard sender.clickedRow >= 0,
                  let box = sender.item(atRow: sender.clickedRow) as? NodeBox else {
                return
            }
            if box.node.isDirectory {
                if sender.isItemExpanded(box) {
                    sender.collapseItem(box)
                } else {
                    sender.expandItem(box)
                }
            } else {
                onOpen(box.node)
            }
        }

        private func box(for item: Any?) -> NodeBox? {
            item as? NodeBox
        }
    }
}

@MainActor
private final class NodeBox: NSObject {
    let node: WorkspaceFileTreeNode
    let children: [NodeBox]

    init(node: WorkspaceFileTreeNode) {
        self.node = node
        self.children = (node.children ?? []).map(NodeBox.init)
    }

    func flattened() -> [NodeBox] {
        [self] + children.flatMap { $0.flattened() }
    }
}

private final class FileCell: NSTableCellView {
    static let identifier = NSUserInterfaceItemIdentifier("FileNavigatorOutlineCell")
    private let symbol = NSImageView()
    private let title = NSTextField(labelWithString: "")
    private let badge = NSTextField(labelWithString: "")

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        identifier = Self.identifier
        wantsLayer = true

        symbol.translatesAutoresizingMaskIntoConstraints = false
        symbol.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 13, weight: .medium)
        title.translatesAutoresizingMaskIntoConstraints = false
        title.lineBreakMode = .byTruncatingMiddle
        title.font = NSFont.systemFont(ofSize: 13)
        badge.translatesAutoresizingMaskIntoConstraints = false
        badge.font = NSFont.monospacedSystemFont(ofSize: 10, weight: .semibold)
        badge.alignment = .right

        addSubview(symbol)
        addSubview(title)
        addSubview(badge)

        NSLayoutConstraint.activate([
            symbol.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 4),
            symbol.centerYAnchor.constraint(equalTo: centerYAnchor),
            symbol.widthAnchor.constraint(equalToConstant: 18),
            title.leadingAnchor.constraint(equalTo: symbol.trailingAnchor, constant: 6),
            title.centerYAnchor.constraint(equalTo: centerYAnchor),
            badge.leadingAnchor.constraint(greaterThanOrEqualTo: title.trailingAnchor, constant: 8),
            badge.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            badge.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        textField = title
        imageView = symbol
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func configure(with node: WorkspaceFileTreeNode, isSelected: Bool) {
        title.stringValue = node.name
        badge.stringValue = statusText(for: node)
        symbol.image = NSImage(systemSymbolName: symbolName(for: node), accessibilityDescription: nil)
        title.textColor = isSelected ? NSColor.white : NSColor(calibratedWhite: 0.18, alpha: 1)
        badge.textColor = isSelected ? NSColor(calibratedWhite: 0.86, alpha: 1) : NSColor(calibratedWhite: 0.48, alpha: 1)
        symbol.contentTintColor = node.isDirectory
            ? NSColor.systemBlue
            : (isSelected ? NSColor(calibratedWhite: 0.84, alpha: 1) : NSColor(calibratedWhite: 0.52, alpha: 1))
    }

    private func symbolName(for node: WorkspaceFileTreeNode) -> String {
        if node.isDirectory { return node.expanded ? "folder.fill" : "folder" }
        switch URL(fileURLWithPath: node.name).pathExtension.lowercased() {
        case "swift": return "swift"
        case "json", "yml", "yaml", "toml": return "curlybraces"
        case "md", "markdown": return "doc.richtext"
        case "js", "jsx", "ts", "tsx": return "chevron.left.forwardslash.chevron.right"
        default: return "doc.text"
        }
    }

    private func statusText(for node: WorkspaceFileTreeNode) -> String {
        if let gitStatus = node.gitStatus, !gitStatus.isEmpty { return gitStatus }
        if let changedCount = node.changedCount, changedCount > 0 { return "\(changedCount)" }
        return ""
    }
}
#endif
