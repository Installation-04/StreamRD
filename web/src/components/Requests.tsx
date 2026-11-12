"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { MetadataCandidate, PROVIDER_LABELS, imdbLink, metadataSourceLink } from "@/lib/metadata";
import { safeMediaUrl } from "@/lib/account-library";
import { AdminMediaRequest, DiscoveryDetail, DiscoveryResults, MediaRequest, RequestEvent, STATUS_LABEL, destinationLabel, mediaHref, playableHref } from "@/lib/requests";
import styles from "./Requests.module.css";
const TORBOX_AVAILABLE = false;
function useResource<T>(path: string, poll = false, enabled = true) {
    const [data, setData] = useState<T | null>(null), [error, setError] = useState(""), [loading, setLoading] = useState(true), [paused, setPaused] = useState(false);
    const active = useRef<AbortController | null>(null);
    const refresh = useCallback(async () => { active.current?.abort(); const controller = new AbortController(); active.current = controller; setLoading(true); setError(""); try {
        const response = await api<T>(path, { signal: controller.signal });
        if (!controller.signal.aborted)
            setData(response);
    }
    catch (reason) {
        if (!controller.signal.aborted)
            setError((reason as Error).message);
    }
    finally {
        if (!controller.signal.aborted)
            setLoading(false);
    } }, [path]);
    useEffect(() => { if (!enabled) {
        active.current?.abort();
        return;
    } setData(null); setPaused(false); void refresh(); let rounds = 0; const timer = poll ? setInterval(() => { if (document.visibilityState !== "visible")
        return; if (rounds++ >= 120) {
        setPaused(true);
        clearInterval(timer);
        return;
    } void refresh(); }, 5000) : undefined; return () => { clearInterval(timer); active.current?.abort(); }; }, [refresh, poll, enabled]);
    return { data, error, loading, paused, refresh };
}
function useViewer() { const auth = useAuth(), router = useRouter(); useEffect(() => { if (!auth.loading && !auth.user)
    router.replace("/login"); }, [auth.loading, auth.user, router]); return auth; }
function Notice({ children }: {
    children: React.ReactNode;
}) { return <div className={styles.notice}>{children}</div>; }
function ErrorMessage({ message }: {
    message: string;
}) { return message ? <p className={styles.error} role="alert">{message}</p> : null; }
function Poster({ name, url }: {
    name: string;
    url: string | null;
}) { const image = safeMediaUrl(url); return <div className={styles.poster}><span aria-hidden="true">{name}</span>{image && <img src={image} alt={name} loading="lazy" onLoad={event => { event.currentTarget.hidden = false; }} onError={event => { event.currentTarget.hidden = true; }}/>}</div>; }
function Attribution({ provider }: {
    provider: "tmdb" | "omdb" | "free";
}) { return <footer className={styles.attribution}>{provider === "tmdb" && <img src="/metadata/tmdb.svg" alt="TMDB" width={94} height={24}/>}<p>{provider === "tmdb" ? "This product uses the TMDB API but is not endorsed or certified by TMDB." : provider === "free" ? "Metadata from Cinemeta, which serves IMDb-linked data. No account is used." : "IMDb-linked metadata supplied by OMDb."} Metadata and artwork belong to their respective providers.</p></footer>; }
const TRANSFER_LABEL: Record<string, string> = {
    paused: "Paused in qBittorrent.",
    waiting_for_peers: "Waiting for peers in qBittorrent.",
    checking: "Checking downloaded data in qBittorrent.",
    fetching_metadata: "Fetching torrent metadata in qBittorrent.",
    preparing: "Preparing the transfer.",
    awaiting_library_access: "Ask your administrator for access to the shared library.",
};
function Progress({ request }: {
    request: MediaRequest;
}) { const measured = typeof request.progress === "number" && Number.isFinite(request.progress) ? Math.min(100, Math.max(0, request.progress)) : null; return <div className={styles.progressBlock}><div className={styles.statusLine}><span className={styles.status} data-status={request.status}>{STATUS_LABEL[request.status]}</span><span>{destinationLabel(request.destination)}</span></div>{request.downloadState && TRANSFER_LABEL[request.downloadState] && <p className={styles.small}>{TRANSFER_LABEL[request.downloadState]}</p>}{measured !== null && <><div className={styles.measured}><label htmlFor={`progress-${request.id}`}>Measured download progress</label><strong>{Math.round(measured)}%</strong></div><progress aria-label="Measured download progress" id={`progress-${request.id}`} max={100} value={measured}/></>}{measured === null && ["queued", "downloading", "submitting"].includes(request.status) && <p className={styles.small}>The downloader has not reported a percentage yet.</p>}{request.status === "downloaded" && <p className={styles.small}>{request.destination === "local" ? "Downloaded by qBittorrent. Awaiting library import and access." : "Finished in the cloud. Awaiting library scan and access."} A completed download is not automatically playable.</p>}{request.error && <p className={styles.error}>{request.error}</p>}</div>; }
function Timeline({ events }: {
    events: RequestEvent[];
}) { return <ol className={styles.timeline} aria-label="Request history">{events.map(event => <li key={event.id}><span className={styles.timelineDot} aria-hidden="true"/><div><strong>{STATUS_LABEL[event.status]}</strong><p>{event.message}</p><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time></div></li>)}</ol>; }
export function DiscoverySearch() {
    const { user, loading: authLoading } = useViewer();
    const [query, setQuery] = useState(""), [type, setType] = useState("movie"), [provider, setProvider] = useState(""), [results, setResults] = useState<MetadataCandidate[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState("");
    useEffect(() => { const params = new URLSearchParams(window.location.search); setQuery(params.get("q") ?? ""); if (params.get("type") === "series")
        setType("series"); }, []);
    useEffect(() => { const controller = new AbortController(); if (!user || query.trim().length < 2) {
        setResults([]);
        setBusy(false);
        setError("");
        return;
    } setBusy(true); setError(""); const timer = setTimeout(() => { const params = new URLSearchParams({ q: query.trim(), type }); if (provider)
        params.set("provider", provider); api<DiscoveryResults>(`/api/discovery/search?${params}`, { signal: controller.signal }).then(response => { if (!controller.signal.aborted)
        setResults(response.results); }).catch(reason => { if (!controller.signal.aborted) {
        setError((reason as Error).message);
        setResults([]);
    } }).finally(() => { if (!controller.signal.aborted)
        setBusy(false); }); }, 350); return () => { clearTimeout(timer); controller.abort(); }; }, [user, query, type, provider]);
    if (authLoading || !user)
        return <main className={styles.page}><p role="status">Checking your account…</p></main>;
    return <main className={styles.page}><header className={styles.header}><div><p className={styles.eyebrow}>YOUR NEXT WATCH STARTS WITH A REQUEST</p><h1>Discover more.</h1><p>Find movies and shows beyond your library. Request something new and follow its journey from approval to download.</p></div><Link className="btn btn-secondary" href="/requests">My requests →</Link></header><section className={styles.searchPanel} aria-label="Discover movies and shows"><label className={styles.searchField}>Search movies or shows<input type="search" maxLength={200} placeholder="A movie, a show, an IMDb ID…" value={query} onChange={event => setQuery(event.target.value)}/></label><label>Media type<select value={type} onChange={event => setType(event.target.value)}><option value="movie">Movies</option><option value="series">Shows</option></select></label><label>Metadata source<select value={provider} onChange={event => setProvider(event.target.value)}><option value="">Server default</option><option value="tmdb">TMDB</option><option value="omdb">OMDb / IMDb</option><option value="free">Built-in (no account)</option></select></label></section><ErrorMessage message={error}/>{error && <Notice>{user.role === "admin" ? <Link href="/admin/metadata">Check your server’s metadata connection →</Link> : "Your administrator configures metadata discovery. Ask them to check the connection."}</Notice>}{busy && <p role="status" className={styles.small}>Searching movie and show metadata…</p>}{!busy && query.trim().length >= 2 && !error && <p className={styles.small} aria-live="polite">{results.length} {results.length === 1 ? "result" : "results"} · Open a title to check your library or request it.</p>}<section className={styles.results} aria-label="Discovery results" aria-busy={busy}>{results.map(media => <Link className={styles.mediaCard} key={`${media.provider}-${media.type}-${media.id}`} href={mediaHref(media)} aria-label={`View ${media.name}`}><Poster name={media.name} url={media.posterUrl}/><div><h2>{media.name}</h2><p>{media.year ?? "Year unavailable"} · {media.type === "movie" ? "Movie" : "Show"}</p><span>Check availability ↗</span></div></Link>)}</section>{!busy && !error && !results.length && <section className={styles.empty}><p className={styles.eyebrow}>THERE’S ALWAYS ANOTHER GOOD STORY</p><h2>{query.trim().length >= 2 ? "No matching titles yet." : "What would you like to watch?"}</h2><p>{query.trim().length >= 2 ? "Try a more specific title, another spelling, or an IMDb ID." : "Start with a title. Discovery searches the server’s metadata provider, including media not yet in your collection."}</p></section>}{results[0] && <Attribution provider={results[0].provider}/>}</main>;
}
export function DiscoveryMedia() {
    const params = useParams<{
        provider: string;
        type: string;
        id: string;
    }>();
    const { user, loading: authLoading } = useViewer();
    const path = `/api/discovery/${encodeURIComponent(params.provider)}/${encodeURIComponent(params.type)}/${encodeURIComponent(params.id)}`;
    const resource = useResource<DiscoveryDetail>(path, true), [busy, setBusy] = useState(false), [error, setError] = useState("");
    const media = resource.data?.media;
    const requestMedia = async () => { if (!media || busy)
        return; setBusy(true); setError(""); try {
        await api("/api/requests", { method: "POST", body: JSON.stringify({ provider: media.provider, id: media.id, type: media.type }) });
        await resource.refresh();
    }
    catch (reason) {
        setError((reason as Error).message);
    }
    finally {
        setBusy(false);
    } };
    if (authLoading || !user)
        return <main className={styles.page}><p role="status">Checking your account…</p></main>;
    if (!media)
        return <main className={styles.page}><Link href="/discover">← Discover</Link><ErrorMessage message={resource.error}/>{resource.loading && <p role="status">Opening media details…</p>}</main>;
    const request = resource.data!.request, available = resource.data!.availability, backdrop = safeMediaUrl(media.backdropUrl), source = metadataSourceLink(media), imdb = imdbLink(media.imdbId);
    return <main className={styles.page}><Link className={styles.back} href="/discover">← Discover movies & shows</Link><ErrorMessage message={resource.error || error}/><section className={styles.hero}>{backdrop && <img className={styles.backdrop} src={backdrop} alt="" aria-hidden="true"/>}<div className={styles.heroPoster}><Poster name={media.name} url={media.posterUrl}/></div><div className={styles.heroCopy}><p className={styles.eyebrow}>{media.type === "movie" ? "MOVIE" : "SHOW"} · {PROVIDER_LABELS[media.provider]}</p><h1>{media.name}</h1><div className={styles.facts}><span>{media.year ?? "Year unavailable"}</span>{media.runtimeMinutes && <span>{media.runtimeMinutes} min</span>}{media.contentRating && <span>{media.contentRating}</span>}{media.rating !== null && <span>★ {media.rating} <small>{media.ratingSource}</small></span>}</div><p className={styles.overview}>{media.description || "No overview is available from the metadata provider."}</p><div className={styles.tags}>{media.genres.map(genre => <span key={genre}>{genre}</span>)}</div><div className={styles.heroActions}>{available.length ? available.map((item, index) => <Link className="btn" href={playableHref(item.href)} key={`${item.href}-${index}`} title={item.label ?? item.name} style={{ maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{available.length > 1 && item.label ? <><strong>{item.library ?? "Library"}</strong> · {item.label} →</> : <>Open in {item.library ?? (item.kind === "shared" ? item.name : item.kind === "private" ? "my library" : "catalog")} →</>}</Link>) : request?.following ? <Link className="btn" href={`/requests/${encodeURIComponent(request.id)}`}>View my request →</Link> : <button type="button" className="btn" disabled={busy} onClick={() => void requestMedia()}>{busy ? "Submitting…" : request ? "Track this request" : media.type === "movie" ? "Request movie" : "Request show"}</button>}<Link className="btn btn-secondary" href="/requests">My requests</Link></div>{available.length ? <p className={styles.small}>{available.length > 1 ? `Already available to your account, ${available.length} times: each button names the library and the copy it opens.` : "Already available to your account."}</p> : <p className={styles.small}>Not in a library you can access. Request it: the server looks for a release and adds it, or an administrator approves it first if the server is set to ask.</p>}</div></section>{request && <section className={styles.panel} aria-label="Current request status"><h2>From request to movie night.</h2><Progress request={request}/>{!available.length && request.status === "available" && <p className={styles.small}>The server has fulfilled this request. Your administrator still needs to provide library access to your account.</p>}</section>}{media.type === "series" && <Notice>Show requests track the release that is selected for them. Download progress does not mean every season or episode has been acquired.</Notice>}<section className={styles.panel}><h2>Cast & details</h2>{media.cast.length > 0 ? <div className={styles.cast}>{media.cast.slice(0, 18).map(person => <span key={person}>{person}</span>)}</div> : <p className={styles.small}>Cast information is not available.</p>}<div className={styles.links}>{imdb && <a href={imdb} target="_blank" rel="noreferrer">View IMDb ↗</a>}{source && source !== imdb && <a href={source} target="_blank" rel="noreferrer">Metadata source ↗</a>}</div></section>{resource.paused && <Notice>Automatic updates paused after ten minutes. <button type="button" onClick={() => void resource.refresh()}>Refresh status</button></Notice>}<Attribution provider={media.provider}/></main>;
}
export function MyRequests() { const { user, loading: authLoading } = useViewer(), [cursor, setCursor] = useState(""); const resource = useResource<{
    requests: MediaRequest[];
    nextCursor: string | null;
}>(`/api/requests?limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, true); if (authLoading || !user)
    return <main className={styles.page}><p role="status">Checking your account…</p></main>; return <main className={styles.page}><header className={styles.header}><div><p className={styles.eyebrow}>GOOD THINGS ARE ON THEIR WAY</p><h1>My requests.</h1><p>Follow administrator approval and real download progress, whether your media is heading to the cloud or local storage.</p></div><Link className="btn" href="/discover">Find something new →</Link></header><ErrorMessage message={resource.error}/><div className={styles.toolbar}><button type="button" className="btn btn-secondary" disabled={resource.loading} onClick={() => void resource.refresh()}>Refresh requests</button>{resource.paused && <span className={styles.small}>Live updates paused. Refresh to check the latest state.</span>}</div>{resource.loading && !resource.data && <p role="status">Loading your requests…</p>}<section className={styles.requestGrid} aria-label="Your media requests">{resource.data?.requests.map(request => <Link className={styles.requestCard} key={request.id} href={`/requests/${encodeURIComponent(request.id)}`}><div className={styles.requestIdentity}><Poster name={request.name} url={request.posterUrl}/><div><h2>{request.name}</h2><p>{request.year ?? "Year unavailable"} · {request.type === "movie" ? "Movie" : "Show"}</p></div></div><Progress request={request}/><span className={styles.cardAction}>View status & history →</span></Link>)}</section>{!resource.loading && !resource.data?.requests.length && !resource.error && <section className={styles.empty}><h2>Your next watch belongs here.</h2><p>Discover a movie or show and send your first request. You can follow its progress on this page.</p><Link className="btn" href="/discover">Discover movies & shows</Link></section>}<div className={styles.toolbar}>{cursor && <button className="btn btn-secondary" onClick={() => setCursor("")}>Newest requests</button>}{resource.data?.nextCursor && <button className="btn btn-secondary" onClick={() => setCursor(resource.data!.nextCursor!)}>Older requests →</button>}</div></main>; }
export function RequestTracking() {
    const params = useParams<{
        id: string;
    }>(), { user, loading: authLoading } = useViewer(), router = useRouter();
    const resource = useResource<{
        request: MediaRequest;
        events: RequestEvent[];
    }>(`/api/requests/${encodeURIComponent(params.id)}`, true), [busy, setBusy] = useState(false), [error, setError] = useState("");
    const request = resource.data?.request;
    const unfollow = async () => { if (busy || !request)
        return; setBusy(true); setError(""); try {
        await api(`/api/requests/${encodeURIComponent(request.id)}/unfollow`, { method: "POST" });
        router.push("/requests");
    }
    catch (reason) {
        setError((reason as Error).message);
        setBusy(false);
    } };
    if (authLoading || !user)
        return <main className={styles.page}><p role="status">Checking your account…</p></main>;
    return <main className={styles.page}><Link className={styles.back} href="/requests">← My requests</Link><ErrorMessage message={resource.error || error}/>{!request && resource.loading && <p role="status">Loading request history…</p>}{request && <><header className={styles.header}><div><p className={styles.eyebrow}>YOUR REQUEST, IN MOTION</p><h1>{request.name}</h1><p>{request.year ?? "Year unavailable"} · {request.type === "movie" ? "Movie" : "Show"}</p></div><Link className="btn btn-secondary" href={mediaHref(request)}>View media details →</Link></header><section className={styles.panel} aria-label="Download tracking"><Progress request={request}/><p className={styles.small}>Updated {new Date(request.updatedAt).toLocaleString()}. Progress is reported by the downloader; approval and library import are separate steps.</p><button type="button" className="btn btn-secondary" onClick={() => void resource.refresh()} disabled={resource.loading}>Refresh status</button></section>{request.type === "series" && <Notice>This tracks an approved show release, not completion of every season or episode.</Notice>}<section className={styles.panel}><h2>Request history</h2>{resource.data!.events.length ? <Timeline events={resource.data!.events}/> : <p className={styles.small}>No events have been recorded yet.</p>}</section><section className={styles.panel}><h2>Following this request</h2><p className={styles.small}>Stopping tracking removes it from your requests. It does not cancel a download or remove media from the provider or qBittorrent.</p><button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void unfollow()}>{busy ? "Updating…" : "Stop tracking"}</button></section></>}</main>;
}
type OwnedLibrary = {
    id: string;
    name: string;
    enabled: boolean;
    mediaType: "all" | "movie" | "series";
};
function RequestReview({ request, libraries, onChange }: {
    request: AdminMediaRequest;
    libraries: OwnedLibrary[];
    onChange: () => Promise<void>;
}) {
    const [open, setOpen] = useState(false), [destination, setDestination] = useState("cloud"), [providerId, setProviderId] = useState("realdebrid"), [sourceUrl, setSourceUrl] = useState(""), [libraryId, setLibraryId] = useState(""), [reason, setReason] = useState(""), [reference, setReference] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [finding, setFinding] = useState(false), [found, setFound] = useState<{ indexers: number; errors: string[]; candidates: Array<{ title: string; magnet: string; sizeBytes: number; seeders: number; source: string; tags: Array<{ kind: string; label: string }>; pack: boolean }> } | null>(null);
    const details = useResource<{
        request: AdminMediaRequest;
        events: RequestEvent[];
    }>(`/api/admin/requests/${encodeURIComponent(request.id)}`, open, open);
    const mutate = async (action: string, body: unknown) => { if (busy)
        return; setBusy(true); setError(""); try {
        await api(`/api/admin/requests/${encodeURIComponent(request.id)}/${action}`, { method: "POST", body: JSON.stringify(body) });
        setSourceUrl("");
        await onChange();
        await details.refresh();
    }
    catch (problem) {
        setError((problem as Error).message);
    }
    finally {
        setBusy(false);
    } };
    const availableLibraries = libraries.filter(library => library.enabled && (library.mediaType === "all" || library.mediaType === request.type));
    const approvalBlocked = request.status === "attention" && request.downloadState === "approval_blocked";
    const pending = request.status === "requested" || approvalBlocked;
    return <article className={styles.adminRequest} aria-label={`Request for ${request.name}`}><div className={styles.reviewHeading}><div><h3>{request.name}</h3><p>{request.year ?? "Year unavailable"} · {request.type === "movie" ? "Movie" : "Show"} · {request.subscribers.length} {request.subscribers.length === 1 ? "person" : "people"} following</p></div><button className="btn btn-secondary" type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? "Close review" : pending ? "Review request" : "View request history"}</button></div><Progress request={request}/>{open && <div className={styles.reviewBody}><ErrorMessage message={error || details.error}/><p className={styles.small}>Requested by {request.subscribers.map(person => `${person.displayName} (${person.email})`).join(", ") || "No current followers"}.</p>{pending && <form onSubmit={event => { event.preventDefault(); void mutate("approve", { destination, ...(sourceUrl.trim() ? { sourceUrl } : {}), ...(destination === "cloud" ? { providerId, ...(libraryId ? { sharedLibraryId: libraryId } : {}) } : {}) }); }}><div className={styles.formGrid}><label>Download destination<select value={destination} onChange={event => setDestination(event.target.value)}><option value="cloud">Cloud · server debrid account</option><option value="local">Local · qBittorrent</option></select></label>{destination === "cloud" && <label>Cloud provider<select value={providerId} onChange={event => setProviderId(event.target.value)}><option value="realdebrid">Real-Debrid</option><option value="alldebrid">AllDebrid</option><option value="premiumize">Premiumize</option>{TORBOX_AVAILABLE && <option value="torbox">Torbox</option>}</select></label>}<label className={styles.wide}>Release magnet (leave empty and the best release is found automatically)<input aria-label="Approved release magnet" maxLength={10000} value={sourceUrl} onChange={event => setSourceUrl(event.target.value)} placeholder="magnet:?xt=urn:btih:…" autoComplete="off" spellCheck={false}/></label><div className={styles.wide}><button type="button" className="btn btn-secondary" disabled={finding || busy} onClick={() => { setFinding(true); setError(""); setFound(null); api<NonNullable<typeof found>>(`/api/admin/requests/${encodeURIComponent(request.id)}/releases`).then(setFound).catch(problem => setError((problem as Error).message)).finally(() => setFinding(false)); }}>{finding ? "Searching your indexers…" : "Find releases"}</button>{error.includes("No indexer is set up") && <> <Link href="/admin/request-settings">Add an indexer →</Link></>}{found && <div role="region" aria-label="Releases found" style={{ marginTop: 10, display: "grid", gap: 8 }}>{found.candidates.length === 0 ? <p className={styles.small}>Nothing matched in {found.indexers} {found.indexers === 1 ? "indexer" : "indexers"}.{found.errors.length > 0 && ` ${found.errors[0]}.`} You can paste a magnet by hand.</p> : found.candidates.map((candidate, position) => <div key={candidate.magnet} style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between", padding: "8px 10px", border: "1px solid rgba(255,255,255,.14)", borderRadius: 10 }}><span style={{ minWidth: 0, flex: "1 1 320px" }}><strong style={{ wordBreak: "break-word" }}>{candidate.title}</strong><br/><small>{position === 0 ? "★ Best match · " : ""}{candidate.tags.map(tag => tag.label).join(" · ")}{candidate.sizeBytes ? ` · ${(candidate.sizeBytes / 1024 ** 3).toFixed(1)} GB` : ""} · {candidate.seeders} seeders · {candidate.source}{candidate.pack ? " · season pack" : ""}</small></span><button type="button" className="btn btn-sm btn-secondary" aria-pressed={sourceUrl === candidate.magnet} onClick={() => setSourceUrl(candidate.magnet)}>{sourceUrl === candidate.magnet ? "Selected" : "Use this"}</button></div>)}</div>}</div>{destination === "cloud" && <label className={styles.wide}>Shared library after import<select value={libraryId} onChange={event => setLibraryId(event.target.value)}><option value="">No shared library selected</option>{availableLibraries.map(library => <option key={library.id} value={library.id}>{library.name}</option>)}</select></label>}</div><p className={styles.small}>{destination === "local" ? <>Uses your saved qBittorrent connection. <Link href="/admin/request-settings">Configure or test it →</Link> Completed local files still need library import.</> : "Uses your own saved debrid account. An optional shared library must already grant viewers access; this approval does not add library grants."}</p>{request.type === "series" && <Notice>Review which season, episode or pack this magnet contains. Tracking this release does not establish that the entire show is complete.</Notice>}<button type="submit" className="btn" disabled={busy}>{busy ? "Approving…" : sourceUrl.trim() ? "Approve download" : "Find the best release and approve"}</button></form>}{pending && <div className={styles.reject}><label>Reason for rejection (optional)<input value={reason} maxLength={300} onChange={event => setReason(event.target.value)} placeholder="A short note for the requester"/></label><button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void mutate("reject", { reason: reason || undefined })}>Reject request</button></div>}{(request.status === "approved" || approvalBlocked) && <Notice>{approvalBlocked ? "No transfer was submitted. Correct the source or connection, then approve the request again. " : "The job has not started yet. "} <button type="button" disabled={busy} onClick={() => void mutate("cancel", {})}>Cancel before transfer</button></Notice>}{!approvalBlocked && ["attention", "failed"].includes(request.status) && <Notice>Inspect the downloader first. Resuming tracking never adds a transfer again. If submission was uncertain, enter the existing transfer reference below; otherwise leave it blank to reuse the saved reference.<label>Existing transfer reference (optional)<input value={reference} maxLength={200} onChange={event => setReference(event.target.value)} autoComplete="off"/></label><button type="button" disabled={busy} onClick={() => void mutate("resume", { reference: reference.trim() || undefined })}>Resume tracking</button></Notice>}{details.data?.events && <Timeline events={details.data.events}/>}</div>}</article>;
}
export function AdminRequests() { const [status, setStatus] = useState(""), [query, setQuery] = useState(""), [search, setSearch] = useState(""), [cursor, setCursor] = useState(""); useEffect(() => { const timer = setTimeout(() => { setSearch(query.trim()); setCursor(""); }, 300); return () => clearTimeout(timer); }, [query]); const params = new URLSearchParams({ limit: "30" }); if (status)
    params.set("status", status); if (search)
    params.set("q", search); if (cursor)
    params.set("cursor", cursor); const resource = useResource<{
    requests: AdminMediaRequest[];
    nextCursor: string | null;
}>(`/api/admin/requests?${params}`, true); const libraryResource = useResource<{
    libraries: OwnedLibrary[];
}>("/api/admin/shared-libraries"); return <div className={styles.admin}><header className={styles.header}><div><p className={styles.eyebrow}>FAMILY & FRIENDS’ NEXT MOVIE NIGHT</p><h2>Media requests.</h2><p>Review requests, select a release and choose cloud or local delivery. Downloads begin only after your approval.</p></div><Link className="btn btn-secondary" href="/admin/request-settings">Download settings</Link></header><section className={styles.searchPanel} aria-label="Filter media requests"><label className={styles.searchField}>Find a request<input type="search" value={query} maxLength={200} onChange={event => setQuery(event.target.value)} placeholder="Movie or show title"/></label><label>Request status<select value={status} onChange={event => { setStatus(event.target.value); setCursor(""); }}><option value="">All statuses</option>{Object.entries(STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button type="button" className="btn btn-secondary" disabled={resource.loading} onClick={() => void resource.refresh()}>Refresh queue</button></section><ErrorMessage message={resource.error}/>{resource.loading && !resource.data && <p role="status">Loading the request queue…</p>}{resource.data?.requests.map(request => <RequestReview key={request.id} request={request} libraries={libraryResource.data?.libraries ?? []} onChange={resource.refresh}/>)}{!resource.loading && !resource.data?.requests.length && !resource.error && <section className={styles.empty}><h3>Nothing waiting here.</h3><p>New requests from your community appear here for review.</p></section>}<div className={styles.toolbar}>{cursor && <button className="btn btn-secondary" onClick={() => setCursor("")}>Newest requests</button>}{resource.data?.nextCursor && <button className="btn btn-secondary" onClick={() => setCursor(resource.data!.nextCursor!)}>Older requests →</button>}{resource.paused && <p className={styles.small}>Live updates paused. Refresh the queue to continue.</p>}</div></div>; }
type RequestSettings = {
    qbit: {
        enabled: boolean;
        baseUrl: string;
        username: string;
        passwordConfigured: boolean;
        ownedByYou: boolean;
        canReset: boolean;
    };
};
export function RequestSettings() {
    const resource = useResource<{
        settings: RequestSettings;
    }>("/api/admin/request-settings"), [enabled, setEnabled] = useState(false), [baseUrl, setBaseUrl] = useState(""), [username, setUsername] = useState(""), [password, setPassword] = useState(""), [clearPassword, setClearPassword] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
    const saved = resource.data?.settings.qbit;
    useEffect(() => { if (saved) {
        setEnabled(saved.enabled);
        setBaseUrl(saved.baseUrl);
        setUsername(saved.username);
        setPassword("");
        setClearPassword(false);
    } }, [saved]);
    const save = async (event: React.FormEvent) => { event.preventDefault(); if (busy)
        return; setBusy(true); setError(""); setNotice(""); try {
        await api("/api/admin/request-settings", { method: "PUT", body: JSON.stringify({ qbit: { enabled, baseUrl, username, password, clearPassword } }) });
        setPassword("");
        setClearPassword(false);
        await resource.refresh();
        setNotice("qBittorrent settings saved. Test the saved connection before approving a local download.");
    }
    catch (problem) {
        setError((problem as Error).message);
    }
    finally {
        setBusy(false);
    } };
    const test = async () => { setBusy(true); setError(""); setNotice(""); try {
        await api("/api/admin/request-settings/test", { method: "POST", body: "{}" });
        setNotice("The saved qBittorrent connection responded successfully.");
    }
    catch (problem) {
        setError((problem as Error).message);
    }
    finally {
        setBusy(false);
    } };
    const reset = async () => { if (busy || !window.confirm("Reset this qBittorrent connection? Saved credentials will be cleared and local downloads disabled. Existing transfers are not cancelled."))
        return; setBusy(true); setError(""); setNotice(""); try {
        await api("/api/admin/request-settings/reset", { method: "POST", body: "{}" });
        await resource.refresh();
        setNotice("Saved connection reset. Configure fresh credentials before approving a local download.");
    }
    catch (problem) {
        setError((problem as Error).message);
    }
    finally {
        setBusy(false);
    } };
    const otherOwner = Boolean(saved && !saved.ownedByYou && (saved.passwordConfigured || saved.enabled));
    return <div className={styles.admin}><header className={styles.header}><div><p className={styles.eyebrow}>ONE CLEAR DESTINATION FOR EVERY REQUEST</p><h2>Download settings.</h2><p>Cloud requests use your debrid connection. Local requests use the qBittorrent Web UI you configure here.</p></div><Link className="btn btn-secondary" href="/admin/requests">Review requests →</Link></header><ErrorMessage message={error || resource.error}/>{notice && <p className={styles.success} role="status">{notice}</p>}{resource.loading && !saved && <p role="status">Loading download settings…</p>}{otherOwner ? <Notice>Another administrator owns this qBittorrent connection. Its credentials are private; ask that administrator to manage local downloads.</Notice> : <form className={styles.panel} onSubmit={event => void save(event)}><h3>qBittorrent · local downloads</h3><p className={styles.small}>Use the Web UI address reachable from this server, such as a hostname on your local network. Credentials remain on the server and are never shown to viewers.</p><label className={styles.checkbox}><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)}/>Enable local qBittorrent downloads</label><div className={styles.formGrid}><label className={styles.wide}>qBittorrent Web UI URL<input type="url" maxLength={2048} placeholder="http://qbittorrent:8080" value={baseUrl} onChange={event => setBaseUrl(event.target.value)}/></label><label>qBittorrent username<input autoComplete="off" maxLength={200} value={username} onChange={event => setUsername(event.target.value)}/></label><label>qBittorrent password<input type="password" autoComplete="new-password" maxLength={500} placeholder={saved?.passwordConfigured ? "Saved password · leave blank to keep" : "Enter the Web UI password"} value={password} onChange={event => { setPassword(event.target.value); setClearPassword(false); }}/></label></div><p className={styles.small}>{saved?.passwordConfigured ? "A password is saved. Leaving the field blank preserves it." : "No qBittorrent password is saved."}</p><label className={styles.checkbox}><input type="checkbox" checked={clearPassword} onChange={event => { setClearPassword(event.target.checked); if (event.target.checked)
        setPassword(""); }}/>Clear the saved password</label><div className={styles.toolbar}><button className="btn" type="submit" disabled={busy || resource.loading}>{busy ? "Working…" : "Save download settings"}</button><button className="btn btn-secondary" type="button" disabled={busy || !saved?.ownedByYou || !saved.enabled} onClick={() => void test()}>Test saved qBittorrent connection</button><Link href="/account/debrid">Manage my cloud connection →</Link></div></form>}{saved?.canReset && <section className={styles.panel}><h3>Reset saved connection</h3><p className={styles.small}>Clears credentials and disables local downloads. Transfers already in qBittorrent are preserved.</p><button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void reset()}>Reset saved connection</button></section>}<Notice>Requests always require administrator approval. A download completed in qBittorrent still needs to be imported into a library; completion alone does not make it playable in this web app.</Notice></div>;
}
