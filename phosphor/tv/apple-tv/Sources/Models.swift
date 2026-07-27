import Foundation

// MARK: - Domain models
// Field names/types mirror the server's Prisma schema and route handlers
// exactly (see phosphor/server/src/routes/*.ts and prisma/schema.prisma).

struct User: Codable, Identifiable, Hashable {
    let id: String
    let email: String
    let displayName: String
    let role: String
    let active: Bool
    let createdAt: String
}

/// One Torznab search hit. Not persisted server-side, so it has no stable id
/// of its own — `id` is synthesized from fields that are unique together.
struct SearchResult: Codable, Identifiable, Hashable {
    let indexerId: String
    let indexerName: String
    let title: String
    /// Either a magnet URI or a `.torrent` download URL — see `hasMagnet`.
    let link: String
    let hasMagnet: Bool
    let sizeBytes: Int
    let seeders: Int
    let peers: Int
    let publishedAt: String?

    var id: String { "\(indexerId)#\(link)" }
}

struct DownloadJob: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let sourceUrl: String
    let sizeBytes: Int
    let seeders: Int
    let indexerName: String?
    let provider: String
    /// "queued" | "downloading" | "finished" | "error"
    let status: String
    let progress: Int
    let streamUrl: String?
    let filename: String?
    let error: String?
    let createdAt: String
}

enum SortKey: String, CaseIterable, Hashable {
    case seeders
    case size
    case date

    var label: String {
        switch self {
        case .seeders: return "SEEDERS"
        case .size: return "SIZE"
        case .date: return "DATE"
        }
    }
}

// MARK: - API response envelopes

struct AuthResponse: Codable { let token: String; let user: User }
struct HealthResponse: Codable { let status: String; let db: String; let version: String; let time: String }
struct SearchResponse: Codable { let results: [SearchResult]; let errors: [String] }
struct DownloadsResponse: Codable { let jobs: [DownloadJob] }
struct DownloadResponse: Codable { let job: DownloadJob }
struct ProfileResponse: Codable { let user: User }
struct OkResponse: Codable { let ok: Bool }

// MARK: - Formatting helpers

/// Human-readable byte sizes, e.g. `formatBytes(2_254_857_830) == "2.1 GB"`.
func formatBytes(_ bytes: Int) -> String {
    guard bytes > 0 else { return "0 B" }
    let units = ["B", "KB", "MB", "GB", "TB"]
    let exponent = min(units.count - 1, Int(log(Double(bytes)) / log(1024)))
    let value = Double(bytes) / pow(1024, Double(exponent))
    return String(format: exponent == 0 ? "%.0f %@" : "%.1f %@", value, units[exponent])
}

func displayProviderName(_ id: String) -> String {
    switch id {
    case "realdebrid": return "REAL-DEBRID"
    case "alldebrid": return "ALLDEBRID"
    case "premiumize": return "PREMIUMIZE"
    case "torbox": return "TORBOX"
    default: return id.uppercased()
    }
}

// MARK: - Session store

/// Holds the authenticated user + token for the app's lifetime, restores a
/// saved session on launch, and drives login/signup/logout.
@MainActor
final class SessionStore: ObservableObject {
    @Published var token: String? = ApiClient.shared.token
    @Published var user: User?
    @Published var isRestoring = false

    /// Called once at launch. If a token was persisted from a previous run,
    /// validates it against `/api/account/profile`; clears it on failure
    /// (expired/invalid token, unreachable server, etc).
    func restore() async {
        guard token != nil else { return }
        isRestoring = true
        defer { isRestoring = false }
        do {
            let res: ProfileResponse = try await ApiClient.shared.request("/api/account/profile")
            user = res.user
        } catch {
            logout()
        }
    }

    func login(email: String, password: String) async throws {
        let res: AuthResponse = try await ApiClient.shared.request(
            "/api/auth/login",
            method: "POST",
            body: ["email": email, "password": password]
        )
        applyAuth(res)
    }

    func signup(email: String, password: String, displayName: String) async throws {
        let res: AuthResponse = try await ApiClient.shared.request(
            "/api/auth/signup",
            method: "POST",
            body: ["email": email, "password": password, "displayName": displayName]
        )
        applyAuth(res)
    }

    func logout() {
        ApiClient.shared.token = nil
        token = nil
        user = nil
    }

    private func applyAuth(_ res: AuthResponse) {
        ApiClient.shared.token = res.token
        token = res.token
        user = res.user
    }
}
