import Foundation

/// Thin client for the StreamRD REST API. The server URL is user-configurable
/// so the same build works over LAN, reverse proxy or VPN.
final class ApiClient {
    static let shared = ApiClient()

    var baseURL: String {
        get { UserDefaults.standard.string(forKey: "sr_server_url") ?? "http://192.168.1.50:47821" }
        set { UserDefaults.standard.set(newValue, forKey: "sr_server_url") }
    }

    var token: String? {
        get { UserDefaults.standard.string(forKey: "sr_token") }
        set { UserDefaults.standard.set(newValue, forKey: "sr_token") }
    }

    struct ApiError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    func request<T: Decodable>(
        _ path: String,
        method: String = "GET",
        body: [String: Any]? = nil
    ) async throws -> T {
        guard let url = URL(string: baseURL + path) else {
            throw ApiError(message: "Invalid server URL")
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body { req.httpBody = try JSONSerialization.data(withJSONObject: body) }

        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let err = try? JSONDecoder().decode([String: String].self, from: data)
            throw ApiError(message: err?["error"] ?? "HTTP \(status)")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    func health() async -> String {
        struct Health: Decodable { let status: String; let db: String }
        do {
            let h: Health = try await request("/api/health")
            return "Server \(h.status) (db \(h.db))"
        } catch {
            return "Cannot reach \(baseURL)"
        }
    }
}
