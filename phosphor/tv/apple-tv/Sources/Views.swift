import AVKit
import SwiftUI

// MARK: - Auth / server settings

/// Combined "server settings + login/signup" screen shown whenever there is
/// no session. tvOS's top-level navigation is a tab bar (see `MainTabView`),
/// not a push stack, so this is a single flat screen rather than a
/// `NavigationStack` destination.
struct AuthView: View {
    @EnvironmentObject var session: SessionStore

    @State private var serverURL = ApiClient.shared.baseURL
    @State private var healthStatus: String?
    @State private var healthIsError = false

    @State private var mode: AuthMode = .login
    @State private var email = ""
    @State private var password = ""
    @State private var displayName = ""
    @State private var errorMessage: String?
    @State private var isBusy = false

    enum AuthMode: Hashable { case login, signup }

    var body: some View {
        CRTBackground {
            ScrollView {
                VStack(spacing: 40) {
                    VStack(spacing: 6) {
                        TerminalTitle(text: "Phosphor", size: 64)
                        Text("// self-hosted debrid cockpit")
                            .font(.phosphor(18))
                            .foregroundStyle(Color.phosphorDim)
                    }
                    .padding(.top, 20)

                    TerminalPanel(title: "Server") {
                        VStack(alignment: .leading, spacing: 16) {
                            TerminalField(placeholder: "http://192.168.1.50:61337", text: $serverURL)
                            HStack(spacing: 20) {
                                TerminalButton("Save & Test Connection") {
                                    ApiClient.shared.baseURL = serverURL
                                    Task { await testConnection() }
                                }
                                if let healthStatus {
                                    Text(healthStatus)
                                        .font(.phosphor(15))
                                        .foregroundStyle(healthIsError ? Color.terminalError : Color.phosphorGreen)
                                }
                            }
                        }
                    }
                    .frame(maxWidth: 900)

                    TerminalPanel(title: mode == .login ? "Login" : "Create Account") {
                        VStack(alignment: .leading, spacing: 18) {
                            ChipToggle(
                                options: [ChipOption(AuthMode.login, "Login"), ChipOption(AuthMode.signup, "Sign Up")],
                                selection: $mode
                            )

                            if mode == .signup {
                                TerminalField(placeholder: "Display name", text: $displayName)
                            }
                            TerminalField(placeholder: "Email", text: $email)
                            TerminalField(placeholder: "Password (min 8 chars)", text: $password, isSecure: true)

                            if let errorMessage {
                                Text(errorMessage)
                                    .font(.phosphor(15))
                                    .foregroundStyle(Color.terminalError)
                            }

                            TerminalButton(mode == .login ? "Sign In" : "Create Account & Sign In") {
                                Task { await submit() }
                            }
                            .disabled(isBusy)
                        }
                    }
                    .frame(maxWidth: 900)
                }
                .padding(60)
            }
        }
    }

    private func testConnection() async {
        do {
            let h = try await ApiClient.shared.checkHealth()
            healthIsError = h.status != "ok"
            healthStatus = "[\(h.status.uppercased())] DB:\(h.db.uppercased()) v\(h.version)"
        } catch {
            healthIsError = true
            healthStatus = "UNREACHABLE: \(error.localizedDescription)"
        }
    }

    private func submit() async {
        errorMessage = nil
        isBusy = true
        defer { isBusy = false }
        do {
            switch mode {
            case .login:
                try await session.login(email: email, password: password)
            case .signup:
                try await session.signup(email: email, password: password, displayName: displayName)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - Root tab navigation

struct MainTabView: View {
    var body: some View {
        TabView {
            SearchView()
                .tabItem { Label("Search", systemImage: "magnifyingglass") }
            DownloadsView()
                .tabItem { Label("Queue", systemImage: "arrow.down.circle") }
            AccountView()
                .tabItem { Label("Account", systemImage: "person.crop.circle") }
        }
    }
}

// MARK: - Search

/// Search is the entire browsing model for Phosphor — there is no curated
/// catalog. Query + optional filters/sort hit `/api/search`; eligible
/// (`hasMagnet == true`) results can be added straight to the user's debrid
/// queue with one action.
struct SearchView: View {
    @State private var query = ""
    @State private var minSeeders = ""
    @State private var maxSizeGb = ""
    @State private var sort: SortKey = .seeders

    @State private var results: [SearchResult] = []
    @State private var searchErrors: [String] = []
    @State private var isSearching = false
    @State private var loadError: String?

    @State private var addedIds: Set<String> = []
    @State private var addingIds: Set<String> = []
    @State private var addErrors: [String: String] = [:]

    var body: some View {
        CRTBackground {
            VStack(alignment: .leading, spacing: 24) {
                TerminalTitle(text: "Search", size: 40)

                TerminalPanel {
                    VStack(alignment: .leading, spacing: 18) {
                        HStack(spacing: 16) {
                            TerminalField(placeholder: "Search torrents...", text: $query)
                            TerminalButton(isSearching ? "Searching..." : "Search") {
                                Task { await runSearch() }
                            }
                            .disabled(query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSearching)
                        }

                        HStack(alignment: .top, spacing: 32) {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("MIN SEEDERS").font(.phosphor(13, weight: .bold)).foregroundStyle(Color.phosphorDim)
                                TerminalField(placeholder: "0", text: $minSeeders).frame(width: 180)
                            }
                            VStack(alignment: .leading, spacing: 8) {
                                Text("MAX SIZE (GB)").font(.phosphor(13, weight: .bold)).foregroundStyle(Color.phosphorDim)
                                TerminalField(placeholder: "any", text: $maxSizeGb).frame(width: 180)
                            }
                            VStack(alignment: .leading, spacing: 8) {
                                Text("SORT BY").font(.phosphor(13, weight: .bold)).foregroundStyle(Color.phosphorDim)
                                ChipToggle(
                                    options: [
                                        ChipOption(SortKey.seeders, SortKey.seeders.label),
                                        ChipOption(SortKey.size, SortKey.size.label),
                                        ChipOption(SortKey.date, SortKey.date.label),
                                    ],
                                    selection: $sort
                                )
                            }
                        }
                    }
                }

                if !searchErrors.isEmpty {
                    Text("⚠ " + searchErrors.joined(separator: " | "))
                        .font(.phosphor(13))
                        .foregroundStyle(Color.terminalAmber)
                        .lineLimit(2)
                }
                if let loadError {
                    Text(loadError).font(.phosphor(15)).foregroundStyle(Color.terminalError)
                }

                if results.isEmpty {
                    Spacer()
                    Text(query.isEmpty
                         ? "// enter a query to search your configured indexers"
                         : (isSearching ? "// searching..." : "// no results"))
                        .font(.phosphor(18))
                        .foregroundStyle(Color.phosphorDim)
                        .frame(maxWidth: .infinity, alignment: .center)
                    Spacer()
                } else {
                    ScrollView {
                        LazyVStack(spacing: 14) {
                            ForEach(results) { result in
                                SearchResultRow(
                                    result: result,
                                    isAdded: addedIds.contains(result.id),
                                    isAdding: addingIds.contains(result.id),
                                    errorMessage: addErrors[result.id],
                                    onAdd: { Task { await add(result) } }
                                )
                            }
                        }
                        .padding(.bottom, 40)
                    }
                }
            }
            .padding(50)
        }
    }

    private func runSearch() async {
        isSearching = true
        loadError = nil
        defer { isSearching = false }

        var items = [URLQueryItem(name: "q", value: query), URLQueryItem(name: "sort", value: sort.rawValue)]
        if let ms = Int(minSeeders.trimmingCharacters(in: .whitespaces)), ms > 0 {
            items.append(URLQueryItem(name: "minSeeders", value: String(ms)))
        }
        if let mb = Double(maxSizeGb.trimmingCharacters(in: .whitespaces)), mb > 0 {
            items.append(URLQueryItem(name: "maxSizeGb", value: String(mb)))
        }

        do {
            let res: SearchResponse = try await ApiClient.shared.request("/api/search", queryItems: items)
            results = res.results
            searchErrors = res.errors
            addedIds.removeAll()
            addErrors.removeAll()
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func add(_ result: SearchResult) async {
        addingIds.insert(result.id)
        addErrors[result.id] = nil
        defer { addingIds.remove(result.id) }
        do {
            let _: DownloadResponse = try await ApiClient.shared.request(
                "/api/downloads",
                method: "POST",
                body: [
                    "title": result.title,
                    "sourceUrl": result.link,
                    "sizeBytes": result.sizeBytes,
                    "seeders": result.seeders,
                    "indexerName": result.indexerName,
                ]
            )
            addedIds.insert(result.id)
        } catch {
            addErrors[result.id] = error.localizedDescription
        }
    }
}

struct SearchResultRow: View {
    let result: SearchResult
    let isAdded: Bool
    let isAdding: Bool
    let errorMessage: String?
    let onAdd: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 20) {
            VStack(alignment: .leading, spacing: 8) {
                Text(result.title)
                    .font(.phosphor(17, weight: .bold))
                    .foregroundStyle(Color.phosphorGreen)
                    .lineLimit(2)
                HStack(spacing: 20) {
                    Text(formatBytes(result.sizeBytes))
                    Text("\(result.seeders) SEEDS")
                    Text(result.indexerName.uppercased())
                }
                .font(.phosphor(14))
                .foregroundStyle(Color.phosphorDim)

                if let errorMessage {
                    Text(errorMessage).font(.phosphor(13)).foregroundStyle(Color.terminalError)
                }
            }
            Spacer(minLength: 20)
            if result.hasMagnet {
                TerminalButton(isAdded ? "Added" : (isAdding ? "Adding..." : "Add"), action: onAdd)
                    .disabled(isAdded || isAdding)
            } else {
                Text("NO MAGNET")
                    .font(.phosphor(13, weight: .bold))
                    .foregroundStyle(Color.phosphorDim)
                    .padding(.top, 6)
            }
        }
        .padding(18)
        .background(Color.black.opacity(0.35))
        .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.phosphorGreen.opacity(0.35), lineWidth: 1))
    }
}

// MARK: - Downloads / queue

struct DownloadsView: View {
    @State private var jobs: [DownloadJob] = []
    @State private var loadError: String?
    @State private var isLoading = false
    @State private var playURL: URL?
    @State private var showPlayer = false

    var body: some View {
        CRTBackground {
            VStack(alignment: .leading, spacing: 24) {
                HStack {
                    TerminalTitle(text: "Queue", size: 40)
                    Spacer()
                    TerminalButton(isLoading ? "Refreshing..." : "Refresh") { Task { await loadJobs() } }
                        .disabled(isLoading)
                }

                if let loadError {
                    Text(loadError).font(.phosphor(15)).foregroundStyle(Color.terminalError)
                }

                if jobs.isEmpty {
                    Spacer()
                    Text("// queue is empty — add a result from Search")
                        .font(.phosphor(18))
                        .foregroundStyle(Color.phosphorDim)
                        .frame(maxWidth: .infinity, alignment: .center)
                    Spacer()
                } else {
                    ScrollView {
                        LazyVStack(spacing: 14) {
                            ForEach(jobs) { job in
                                DownloadRow(
                                    job: job,
                                    onPlay: { play(job) },
                                    onRemove: { Task { await remove(job) } }
                                )
                            }
                        }
                        .padding(.bottom, 40)
                    }
                }
            }
            .padding(50)
        }
        .task { await loadJobs() }
        .task { await pollLoop() }
        .fullScreenCover(isPresented: $showPlayer) {
            if let playURL { PlayerView(url: playURL) }
        }
    }

    private func loadJobs() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let res: DownloadsResponse = try await ApiClient.shared.request("/api/downloads")
            jobs = res.jobs
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    /// Polls `/refresh` for any job still in flight every few seconds, for as
    /// long as this screen is on-screen. Cancelled automatically when the
    /// view disappears (`.task` ties the child Task to the view's lifetime).
    private func pollLoop() async {
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            if Task.isCancelled { break }
            await refreshActiveJobs()
        }
    }

    private func refreshActiveJobs() async {
        let active = jobs.filter { $0.status == "queued" || $0.status == "downloading" }
        guard !active.isEmpty else { return }
        for job in active {
            do {
                let res: DownloadResponse = try await ApiClient.shared.request(
                    "/api/downloads/\(job.id)/refresh", method: "POST"
                )
                if let idx = jobs.firstIndex(where: { $0.id == job.id }) {
                    jobs[idx] = res.job
                }
            } catch {
                // Leave the job as-is; the next poll cycle will retry.
            }
        }
    }

    private func play(_ job: DownloadJob) {
        guard let streamUrl = job.streamUrl, let url = URL(string: streamUrl) else { return }
        playURL = url
        showPlayer = true
    }

    private func remove(_ job: DownloadJob) async {
        do {
            let _: OkResponse = try await ApiClient.shared.request("/api/downloads/\(job.id)", method: "DELETE")
            jobs.removeAll { $0.id == job.id }
        } catch {
            loadError = error.localizedDescription
        }
    }
}

struct DownloadRow: View {
    let job: DownloadJob
    let onPlay: () -> Void
    let onRemove: () -> Void

    private var isActive: Bool { job.status == "queued" || job.status == "downloading" }

    var body: some View {
        HStack(alignment: .top, spacing: 20) {
            VStack(alignment: .leading, spacing: 8) {
                Text(job.title)
                    .font(.phosphor(17, weight: .bold))
                    .foregroundStyle(Color.phosphorGreen)
                    .lineLimit(2)

                HStack(spacing: 18) {
                    StatusBadge(status: job.status)
                    if isActive {
                        Text("\(job.progress)%")
                    }
                    Text(formatBytes(job.sizeBytes))
                    Text(displayProviderName(job.provider))
                    if let indexerName = job.indexerName {
                        Text(indexerName.uppercased())
                    }
                }
                .font(.phosphor(14))
                .foregroundStyle(Color.phosphorDim)

                if isActive {
                    ProgressView(value: Double(job.progress), total: 100)
                        .tint(Color.phosphorGreen)
                        .frame(maxWidth: 420)
                }
                if let error = job.error {
                    Text(error).font(.phosphor(13)).foregroundStyle(Color.terminalError)
                }
            }
            Spacer(minLength: 20)
            HStack(spacing: 14) {
                if job.status == "finished", job.streamUrl != nil {
                    TerminalButton("Play", action: onPlay)
                }
                TerminalButton("Remove", isDestructive: true, action: onRemove)
            }
        }
        .padding(18)
        .background(Color.black.opacity(0.35))
        .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.phosphorGreen.opacity(0.35), lineWidth: 1))
    }
}

// MARK: - Account

struct AccountView: View {
    @EnvironmentObject var session: SessionStore
    @State private var serverURL = ApiClient.shared.baseURL
    @State private var healthStatus: String?
    @State private var healthIsError = false

    var body: some View {
        CRTBackground {
            VStack(alignment: .leading, spacing: 32) {
                TerminalTitle(text: "Account", size: 40)

                TerminalPanel(title: "Signed in as") {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(session.user?.displayName ?? "—")
                            .font(.phosphor(20, weight: .bold))
                            .foregroundStyle(Color.phosphorGreen)
                        Text(session.user?.email ?? "—")
                            .font(.phosphor(15))
                            .foregroundStyle(Color.phosphorDim)
                        Text("ROLE: \((session.user?.role ?? "—").uppercased())")
                            .font(.phosphor(13))
                            .foregroundStyle(Color.phosphorDim)
                    }
                }
                .frame(maxWidth: 900)

                TerminalPanel(title: "Server") {
                    VStack(alignment: .leading, spacing: 16) {
                        TerminalField(placeholder: "Server URL", text: $serverURL)
                        HStack(spacing: 20) {
                            TerminalButton("Save & Test") {
                                ApiClient.shared.baseURL = serverURL
                                Task { await testConnection() }
                            }
                            if let healthStatus {
                                Text(healthStatus)
                                    .font(.phosphor(15))
                                    .foregroundStyle(healthIsError ? Color.terminalError : Color.phosphorGreen)
                            }
                        }
                    }
                }
                .frame(maxWidth: 900)

                TerminalButton("Sign Out", isDestructive: true) { session.logout() }

                Spacer()
            }
            .padding(50)
        }
    }

    private func testConnection() async {
        do {
            let h = try await ApiClient.shared.checkHealth()
            healthIsError = h.status != "ok"
            healthStatus = "[\(h.status.uppercased())] DB:\(h.db.uppercased()) v\(h.version)"
        } catch {
            healthIsError = true
            healthStatus = "UNREACHABLE: \(error.localizedDescription)"
        }
    }
}

// MARK: - Playback

/// Full-screen playback of a resolved debrid stream URL. Idle-timer
/// suppression mirrors the pattern used elsewhere in this monorepo's tvOS
/// clients: disable while a video is on screen, restore on dismissal.
struct PlayerView: View {
    let url: URL

    var body: some View {
        VideoPlayer(player: AVPlayer(url: url))
            .ignoresSafeArea()
            .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
            .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
    }
}
