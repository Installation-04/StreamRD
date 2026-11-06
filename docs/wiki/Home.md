# StreamRD and Phosphor wiki

This repository contains two self-hosted apps that connect your own debrid accounts
to a web interface and device clients. They have separate servers, databases,
accounts, and deployments. Neither service is a transcoding media server.

| Choose | Purpose | API / web ports |
|---|---|---|
| StreamRD | Browse an administrator-curated catalog, save favorites, and resume viewing by profile | 47821 / 3000 |
| Phosphor | Search your Torznab indexers, add results to debrid, and manage a download queue | 61337 / 3100 |

Start with [Getting started](https://github.com/Installation-04/StreamRD/wiki/Getting-started), then follow the
[StreamRD guide](https://github.com/Installation-04/StreamRD/wiki/StreamRD-guide) or [Phosphor guide](https://github.com/Installation-04/StreamRD/wiki/Phosphor-guide).
For upgrades, read [System and upgrades](https://github.com/Installation-04/StreamRD/wiki/System-and-upgrades) and [Operations and recovery](https://github.com/Installation-04/StreamRD/wiki/Operations-and-recovery).

- [Architecture](https://github.com/Installation-04/StreamRD/wiki/Architecture): request flow, provider handling, data, and optimization choices.
- [Screenshots](https://github.com/Installation-04/StreamRD/wiki/Screenshots): twenty Safe Upgrades screens with demo-data provenance.
- [Troubleshooting](https://github.com/Installation-04/StreamRD/wiki/Troubleshooting): ports, login, playback, indexers, and storage.
- [Releases](https://github.com/Installation-04/StreamRD/wiki/Releases): versions, compatibility, validation, and downloads.

The version-controlled source of this wiki is
[docs/wiki](https://github.com/Installation-04/StreamRD/tree/main/docs/wiki).
The documented server/web release is **v0.4.0**. Native clients remain separate
projects; this release does not provide newly built device binaries.

- [Plex and Jellyfin](https://github.com/Installation-04/StreamRD/wiki/Plex-and-Jellyfin): optional mounted-media symlink libraries.

- [Project HQ and community roadmap](https://github.com/Installation-04/StreamRD/wiki/Project-HQ)
