import type { MetadataDetails, MetadataCandidate } from "./metadata";
export type RequestStatus = "requested" | "approved" | "submitting" | "queued" | "downloading" | "downloaded" | "available" | "rejected" | "cancelled" | "attention" | "failed";
export interface MediaRequest {
    id: string;
    provider: "tmdb" | "omdb" | "free";
    externalId: string;
    type: "movie" | "series";
    name: string;
    year: number | null;
    posterUrl: string | null;
    status: RequestStatus;
    destination: "cloud" | "local" | null;
    progress: number | null;
    downloadState: string | null;
    error: string | null;
    createdAt: string;
    updatedAt: string;
    following: boolean;
}
export interface RequestEvent {
    id: string;
    status: RequestStatus;
    message: string;
    progress: number | null;
    createdAt: string;
}
export interface AdminMediaRequest extends MediaRequest {
    subscribers: {
        id: string;
        email: string;
        displayName: string;
    }[];
    sharedLibraryId: string | null;
    providerId: string | null;
}
export interface DiscoveryDetail {
    media: MetadataDetails;
    availability: {
        kind: "private" | "shared";
        name: string;
        href: string;
        /** Which library the title is in, and which copy of it: what tells several buttons apart. */
        library?: string;
        label?: string;
    }[];
    request: MediaRequest | null;
}
export type DiscoveryResults = {
    results: MetadataCandidate[];
};
export const STATUS_LABEL: Record<RequestStatus, string> = { requested: "Awaiting approval", approved: "Approved", submitting: "Sending to downloader", queued: "Queued", downloading: "Downloading", downloaded: "Download complete", available: "Available on server", rejected: "Not approved", cancelled: "Cancelled", attention: "Needs administrator", failed: "Download failed" };
export const destinationLabel = (destination: MediaRequest["destination"]) => destination === "cloud" ? "Cloud download" : destination === "local" ? "Local · qBittorrent" : "Destination not assigned";
export const mediaHref = (media: {
    provider: string;
    type: string;
    id?: string;
    externalId?: string;
}) => `/discover/${encodeURIComponent(media.provider)}/${encodeURIComponent(media.type)}/${encodeURIComponent(media.id ?? media.externalId ?? "")}`;
export const playableHref = (href: string) => href.startsWith("/") && !href.startsWith("//") ? href : "/shared-libraries";
