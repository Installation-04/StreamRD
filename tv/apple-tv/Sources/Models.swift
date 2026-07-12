import Foundation

struct User: Codable {
    let id: String
    let email: String
    let displayName: String
    let role: String
}

struct Title: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let description: String
    let type: String
    let genres: [String]
    let year: Int?
    let posterUrl: String?
    let backdropUrl: String?
    let sourceCount: Int
}

struct CatalogRow: Codable, Identifiable {
    let id: String
    let label: String
    let titles: [Title]
}

struct StreamInfo: Codable {
    let url: String
    let provider: String
    let quality: String?
}

struct RowsResponse: Codable { let rows: [CatalogRow] }
struct TitleResponse: Codable { let title: Title }
struct PlayResponse: Codable { let stream: StreamInfo }
struct AuthResponse: Codable { let token: String; let user: User }
struct ProfileResponse: Codable { let user: User }

@MainActor
final class SessionStore: ObservableObject {
    @Published var token: String? = ApiClient.shared.token
    @Published var user: User?

    func restore() async {
        guard token != nil else { return }
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
        ApiClient.shared.token = res.token
        token = res.token
        user = res.user
    }

    func logout() {
        ApiClient.shared.token = nil
        token = nil
        user = nil
    }
}
