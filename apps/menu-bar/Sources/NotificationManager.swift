import Foundation
import UserNotifications

actor NotificationManager {
    static let shared = NotificationManager()

    private var authorized = false

    func requestAuthorization() async {
        let center = UNUserNotificationCenter.current()
        do {
            authorized = try await center.requestAuthorization(options: [.alert, .sound, .badge])
        } catch {
            authorized = false
        }
    }

    func notifyConflict(path: String, remotePeerId: String) async {
        guard authorized else { return }

        let content = UNMutableNotificationContent()
        content.title = "Sync Conflict"
        content.body = "\(path) was modified by both you and \(remotePeerId)"
        content.sound = .default
        content.categoryIdentifier = "SYNC_CONFLICT"

        let request = UNNotificationRequest(
            identifier: "conflict-\(path)",
            content: content,
            trigger: nil
        )

        try? await UNUserNotificationCenter.current().add(request)
    }

    func notifyShareInvite(ownerHandle: String, path: String, role: String) async {
        guard authorized else { return }

        let content = UNMutableNotificationContent()
        content.title = "Share Invitation"
        content.body = "\(ownerHandle) shared \(path) with you as \(role)"
        content.sound = .default
        content.categoryIdentifier = "SHARE_INVITE"

        let request = UNNotificationRequest(
            identifier: "invite-\(ownerHandle)-\(path)",
            content: content,
            trigger: nil
        )

        try? await UNUserNotificationCenter.current().add(request)
    }

    func notifyAccessRevoked(ownerHandle: String, path: String) async {
        guard authorized else { return }

        let content = UNMutableNotificationContent()
        content.title = "Access Revoked"
        content.body = "\(ownerHandle) revoked your access to \(path)"
        content.sound = .default

        let request = UNNotificationRequest(
            identifier: "revoked-\(ownerHandle)-\(path)",
            content: content,
            trigger: nil
        )

        try? await UNUserNotificationCenter.current().add(request)
    }

    func registerCategories() {
        let resolveAction = UNNotificationAction(
            identifier: "RESOLVE",
            title: "Resolve",
            options: [.foreground]
        )

        let conflictCategory = UNNotificationCategory(
            identifier: "SYNC_CONFLICT",
            actions: [resolveAction],
            intentIdentifiers: []
        )

        let acceptAction = UNNotificationAction(
            identifier: "ACCEPT",
            title: "Accept",
            options: []
        )

        let declineAction = UNNotificationAction(
            identifier: "DECLINE",
            title: "Decline",
            options: [.destructive]
        )

        let inviteCategory = UNNotificationCategory(
            identifier: "SHARE_INVITE",
            actions: [acceptAction, declineAction],
            intentIdentifiers: []
        )

        UNUserNotificationCenter.current().setNotificationCategories([
            conflictCategory,
            inviteCategory,
        ])
    }
}
