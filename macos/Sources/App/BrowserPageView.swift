#if os(macOS)
import SwiftUI
import WebKit
import AppKit
import DesignSystem

struct BrowserPageView: View {
    private struct DevTarget: Identifiable {
        let id: String
        let title: String
        let subtitle: String
        let url: String
        let icon: String
    }

    @State private var address = ""
    @State private var currentURL: URL?

    private let commonTargets: [DevTarget] = [
        DevTarget(id: "next", title: "Next.js", subtitle: "localhost:3000", url: "http://localhost:3000", icon: "bolt.horizontal"),
        DevTarget(id: "vite", title: "Vite", subtitle: "localhost:5173", url: "http://localhost:5173", icon: "sparkles"),
        DevTarget(id: "api", title: "API", subtitle: "localhost:8080", url: "http://localhost:8080", icon: "server.rack"),
        DevTarget(id: "docs", title: "Docs", subtitle: "localhost:8000", url: "http://localhost:8000", icon: "doc.text"),
        DevTarget(id: "preview", title: "Preview", subtitle: "localhost:3001", url: "http://localhost:3001", icon: "rectangle.and.text.magnifyingglass")
    ]

    var body: some View {
        VStack(spacing: Spacing.x3) {
            header
            Group {
                if let currentURL {
                    BrowserWebView(url: currentURL) { navigatedURL in
                        address = navigatedURL.absoluteString
                        self.currentURL = navigatedURL
                    }
                        .clipShape(RoundedRectangle(cornerRadius: Radius.panel, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: Radius.panel, style: .continuous)
                                .strokeBorder(Color.hairlineDark.opacity(0.8), lineWidth: 1)
                        )
                        .shadow(color: Color.black.opacity(0.08), radius: 14, y: 7)
                } else {
                    emptyState
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .padding(.horizontal, Spacing.x5)
        .padding(.vertical, Spacing.x4)
        .background(Color.canvasVoid)
    }

    private var header: some View {
        VStack(spacing: Spacing.x3) {
            HStack {
                Label("Browser", systemImage: "globe")
                    .font(.plexSans(13, weight: .semibold))
                    .foregroundStyle(Color.inkPrimary)
                Spacer()
                Button {
                    if let currentURL {
                        NSWorkspace.shared.open(currentURL)
                    }
                } label: {
                    Image(systemName: "arrow.up.forward.square")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Color.inkTertiary)
                        .iconHitTarget(32)
                        .background(Color.surfaceCard, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(currentURL == nil)
                .help("Open in system browser")
            }

            HStack(spacing: Spacing.x2) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.inkTertiary)
                TextField("localhost:3000 or https://example.com", text: $address)
                    .textFieldStyle(.plain)
                    .font(.plexSans(13, weight: .medium))
                    .onSubmit { openAddress() }
                Button("Open") { openAddress() }
                    .font(.plexSans(12, weight: .semibold))
                    .buttonStyle(.plain)
                    .padding(.horizontal, Spacing.x3)
                    .frame(height: 28)
                    .background(Color.surfaceTerminal, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                    .foregroundStyle(Color.canvasVoid)
            }
            .padding(.horizontal, Spacing.x3)
            .frame(height: 42)
            .background(Color.surfaceCard, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .strokeBorder(Color.hairlineDark.opacity(0.75), lineWidth: 1)
            )
        }
    }

    private var emptyState: some View {
        VStack(spacing: Spacing.x5) {
            Spacer(minLength: 0)
            VStack(spacing: Spacing.x2) {
                Image(systemName: "globe.badge.chevron.backward")
                    .font(.system(size: 42, weight: .light))
                    .foregroundStyle(Color.signalLive)
                Text("Open a local preview")
                    .font(.plexSans(24, weight: .semibold))
                    .foregroundStyle(Color.inkPrimary)
                Text("Choose a common dev server or enter a URL above. Port-forwarded previews will appear here later.")
                    .font(.plexSans(14))
                    .foregroundStyle(Color.inkTertiary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 560)
            }

            LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), spacing: Spacing.x3)], spacing: Spacing.x3) {
                ForEach(commonTargets) { target in
                    Button {
                        open(target.url)
                    } label: {
                        VStack(alignment: .leading, spacing: Spacing.x3) {
                            Image(systemName: target.icon)
                                .font(.system(size: 22, weight: .medium))
                                .foregroundStyle(Color.signalLive)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(target.title)
                                    .font(.plexSans(15, weight: .semibold))
                                    .foregroundStyle(Color.inkPrimary)
                                Text(target.subtitle)
                                    .font(.plexMono(12, weight: .medium))
                                    .foregroundStyle(Color.inkTertiary)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(Spacing.x4)
                        .background(Color.surfaceCard, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                                .strokeBorder(Color.hairlineDark.opacity(0.75), lineWidth: 1)
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(maxWidth: 760)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.surfaceRail, in: RoundedRectangle(cornerRadius: Radius.panel, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Radius.panel, style: .continuous)
                .strokeBorder(Color.hairlineDark.opacity(0.65), lineWidth: 1)
        )
    }

    private func openAddress() {
        open(address)
    }

    private func open(_ raw: String) {
        guard let url = normalizeURL(raw) else { return }
        address = url.absoluteString
        currentURL = url
    }

    private func normalizeURL(_ raw: String) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if trimmed.contains("://") {
            guard let url = URL(string: trimmed),
                  let scheme = url.scheme?.lowercased(),
                  ["http", "https"].contains(scheme) else {
                return nil
            }
            return url
        }
        return URL(string: "http://\(trimmed)")
    }
}

private struct BrowserWebView: NSViewRepresentable {
    let url: URL
    let onURLChange: @MainActor (URL) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onURLChange: onURLChange)
    }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = true
        view.underPageBackgroundColor = .clear
        context.coordinator.observeURLChanges(in: view)
        load(url, in: view, coordinator: context.coordinator)
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        guard context.coordinator.lastURL != url else { return }
        load(url, in: view, coordinator: context.coordinator)
    }

    private func load(_ url: URL, in view: WKWebView, coordinator: Coordinator) {
        coordinator.lastURL = url
        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        view.load(request)
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var lastURL: URL?
        private var urlObservation: NSKeyValueObservation?

        private let onURLChange: @MainActor (URL) -> Void

        init(onURLChange: @escaping @MainActor (URL) -> Void) {
            self.onURLChange = onURLChange
            super.init()
        }

        func observeURLChanges(in webView: WKWebView) {
            urlObservation?.invalidate()
            urlObservation = webView.observe(\.url, options: [.new]) { [weak self] _, change in
                guard let self, let url = change.newValue.flatMap({ $0 }) else { return }
                Task { @MainActor in
                    self.syncURL(url)
                }
            }
        }

        @MainActor
        func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
            guard let url = webView.url else { return }
            syncURL(url)
        }

        @MainActor
        private func syncURL(_ url: URL) {
            guard lastURL != url else { return }
            lastURL = url
            onURLChange(url)
        }

        deinit {
            urlObservation?.invalidate()
        }
    }
}
#endif
