import Foundation

/// Thin async/await client for the Phosphor REST API. The server address is
/// user-configurable (LAN IP, hostname, reverse proxy, ...) so the same build
/// works anywhere the user's self-hosted server lives.
final class ApiClient {
    static let shared = ApiClient()

    private enum Keys {
        static let serverURL = "phosphor_server_url"
        static let token = "phosphor_token"
    }

    /// Persisted via UserDefaults. Default matches the server's documented
    /// out-of-the-box LAN address.
    var baseURL: String {
        get { UserDefaults.standard.string(forKey: Keys.serverURL) ?? "http://192.168.1.50:61337" }
        set { UserDefaults.standard.set(newValue, forKey: Keys.serverURL) }
    }

    var token: String? {
        get { UserDefaults.standard.string(forKey: Keys.token) }
        set { UserDefaults.standard.set(newValue, forKey: Keys.token) }
    }

    struct ApiError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    /// Mirrors the shape of the server's JSON error bodies, e.g.
    /// `{"error": "Invalid request", "details": ["email: Invalid email"]}`.
    private struct ErrorBody: Decodable {
        let error: String?
        let details: [String]?
    }

    /// Generic JSON request. Attaches the bearer token when present, encodes
    /// `body` as a JSON object, and decodes the response as `T`. Non-2xx
    /// responses are surfaced as `ApiError` using the server's `{error: ...}`
    /// (optionally with `details`) body.
    @discardableResult
    func request<T: Decodable>(
        _ path: String,
        method: String = "GET",
        queryItems: [URLQueryItem]? = nil,
        body: [String: Any]? = nil
    ) async throws -> T {
        var components = URLComponents(string: baseURL + path)
        if let queryItems, !queryItems.isEmpty {
            components?.queryItems = queryItems
        }
        guard let url = components?.url else {
            throw ApiError(message: "Invalid server URL: \(baseURL)")
        }

        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body { req.httpBody = try JSONSerialization.data(withJSONObject: body) }

        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let errBody = try? JSONDecoder().decode(ErrorBody.self, from: data)
            var message = errBody?.error ?? "HTTP \(status)"
            if let details = errBody?.details, !details.isEmpty {
                message += ": " + details.joined(separator: "; ")
            }
            throw ApiError(message: message)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// Convenience wrapper around `GET /api/health`, used by the "test
    /// connection" action on the settings/login screen.
    func checkHealth() async throws -> HealthResponse {
        try await request("/api/health")
    }
}
