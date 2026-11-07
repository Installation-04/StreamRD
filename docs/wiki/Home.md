# StreamRD and Phosphor wiki

This repository contains two self-hosted apps with private and explicitly shared
debrid media libraries. Administrators connect their server account; invited web
viewers can watch granted libraries without their own provider keys. The apps have
separate servers, databases, accounts and deployments. Neither transcodes video.

| Choose | Purpose | API / web ports |
|---|---|---|
| StreamRD | Browse an administrator-curated catalog, save favorites, and resume viewing by profile | 47821 / 3000 |
| Phosphor | Search your Torznab indexers, add results to debrid, and manage a download queue | 61337 / 3100 |

Start with [Getting started](https://github.com/Installation-04/StreamRD/wiki/Getting-started), then follow the
[StreamRD guide](https://github.com/Installation-04/StreamRD/wiki/StreamRD-guide) or [Phosphor guide](https://github.com/Installation-04/StreamRD/wiki/Phosphor-guide).
For upgrades, read [System and upgrades](https://github.com/Installation-04/StreamRD/wiki/System-and-upgrades) and [Operations and recovery](https://github.com/Installation-04/StreamRD/wiki/Operations-and-recovery).

- [Architecture](https://github.com/Installation-04/StreamRD/wiki/Architecture): request flow, provider handling, data, and optimization choices.
- [Screenshots](https://github.com/Installation-04/StreamRD/wiki/Screenshots): fifty Server Sharing screens with demo-data provenance.
- [Troubleshooting](https://github.com/Installation-04/StreamRD/wiki/Troubleshooting): ports, login, playback, indexers, and storage.
- [Releases](https://github.com/Installation-04/StreamRD/wiki/Releases): versions, compatibility, validation, and downloads.

The version-controlled source of this wiki is
[docs/wiki](https://github.com/Installation-04/StreamRD/tree/main/docs/wiki).
The documented server/web release is **v0.6.0**. Native clients remain separate
projects; this release does not provide newly built device binaries.

- [Plex and Jellyfin](https://github.com/Installation-04/StreamRD/wiki/Plex-and-Jellyfin): optional mounted-media symlink libraries.

- [Project HQ and community roadmap](https://github.com/Installation-04/StreamRD/wiki/Project-HQ)

- [My library and account scans](https://github.com/Installation-04/StreamRD/wiki/Account-library): import existing debrid torrents privately during onboarding.
- [Metadata and matching](https://github.com/Installation-04/StreamRD/wiki/Metadata-and-matching): artwork, details, IMDb references and reviewed corrections.

- [Users and server sharing](https://github.com/Installation-04/StreamRD/wiki/Users-and-sharing): invitations, named-library grants and playback without viewer keys.
