import AVKit
import SwiftUI

// MARK: - Login & settings

struct LoginView: View {
    @EnvironmentObject var session: SessionStore
    @State private var email = ""
    @State private var password = ""
    @State private var serverURL = ApiClient.shared.baseURL
    @State private var status: String?
    @State private var error: String?

    var body: some View {
        VStack(spacing: 24) {
            Text("STREAMRD")
                .font(.system(size: 56, weight: .black))
                .foregroundStyle(.red)

            TextField("Server URL (http://192.168.1.50:4000)", text: $serverURL)
                .textInputAutocapitalization(.never)
                .frame(maxWidth: 700)
            Button("Save & test connection") {
                ApiClient.shared.baseURL = serverURL
                Task { status = await ApiClient.shared.health() }
            }
            if let status { Text(status).foregroundStyle(.secondary) }

            TextField("Email", text: $email)
                .textInputAutocapitalization(.never)
                .frame(maxWidth: 700)
            SecureField("Password", text: $password)
                .frame(maxWidth: 700)
            if let error { Text(error).foregroundStyle(.red) }
            Button("Sign in") {
                Task {
                    do { try await session.login(email: email, password: password) }
                    catch { self.error = error.localizedDescription }
                }
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(60)
    }
}

// MARK: - Home rows

struct HomeView: View {
    @EnvironmentObject var session: SessionStore
    @State private var rows: [CatalogRow] = []
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 36) {
                    HStack {
                        Text("STREAMRD")
                            .font(.system(size: 38, weight: .black))
                            .foregroundStyle(.red)
                        Spacer()
                        Button("Sign out") { session.logout() }
                    }
                    if let error { Text(error).foregroundStyle(.red) }
                    ForEach(rows) { row in
                        VStack(alignment: .leading, spacing: 14) {
                            Text(row.label).font(.title3.bold())
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 24) {
                                    ForEach(row.titles) { title in
                                        NavigationLink(value: title) {
                                            PosterCard(title: title)
                                        }
                                        .buttonStyle(.card)
                                    }
                                }
                            }
                        }
                    }
                }
                .padding(48)
            }
            .navigationDestination(for: Title.self) { DetailView(title: $0) }
            .task {
                do {
                    let res: RowsResponse = try await ApiClient.shared.request("/api/catalog/rows")
                    rows = res.rows
                } catch {
                    self.error = error.localizedDescription
                }
            }
        }
    }
}

struct PosterCard: View {
    let title: Title

    var body: some View {
        Group {
            if let poster = title.posterUrl, let url = URL(string: poster) {
                AsyncImage(url: url) { $0.resizable() } placeholder: { Color.gray.opacity(0.2) }
            } else {
                ZStack {
                    Color.gray.opacity(0.2)
                    Text(title.name).multilineTextAlignment(.center).padding(8)
                }
            }
        }
        .frame(width: 220, height: 330)
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

// MARK: - Detail & playback

struct DetailView: View {
    let title: Title
    @State private var streamURL: URL?
    @State private var error: String?
    @State private var showPlayer = false

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(title.name).font(.largeTitle.bold())
            Text(([title.year.map(String.init)] + title.genres).compactMap { $0 }.joined(separator: " · "))
                .foregroundStyle(.secondary)
            Text(title.description)
                .frame(maxWidth: 900, alignment: .leading)
            if let error { Text(error).foregroundStyle(.red) }
            Button("▶ Play") {
                Task {
                    do {
                        let res: PlayResponse = try await ApiClient.shared.request(
                            "/api/play", method: "POST", body: ["titleId": title.id]
                        )
                        streamURL = URL(string: res.stream.url)
                        showPlayer = streamURL != nil
                    } catch {
                        self.error = error.localizedDescription
                    }
                }
            }
            .buttonStyle(.borderedProminent)
            Spacer()
        }
        .padding(60)
        .fullScreenCover(isPresented: $showPlayer) {
            if let streamURL {
                PlayerView(url: streamURL)
            }
        }
    }
}

struct PlayerView: View {
    let url: URL

    var body: some View {
        VideoPlayer(player: AVPlayer(url: url))
            .ignoresSafeArea()
            .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
            .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
    }
}
