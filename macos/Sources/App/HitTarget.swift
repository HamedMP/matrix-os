#if os(macOS)
import SwiftUI

extension View {
    func iconHitTarget(_ size: CGFloat = 32) -> some View {
        frame(width: size, height: size)
            .contentShape(Rectangle())
    }
}
#endif
