# Plex and Jellyfin

Both apps optionally export mounted media as real symlinks in movie and episode
folder layouts. Normal URL playback continues without a mount. Configure exports
under **Admin → Plex / Jellyfin**.

Read the complete [mount, naming, scanning, and recovery guide](https://github.com/Installation-04/StreamRD/blob/main/docs/plex-jellyfin.md).
It includes the optional Docker override, identical source paths in both scanners,
permissions, mount-outage behavior, and all export API endpoints.

Exports require existing mounted files, for example via rclone/Zurg. HTTPS stream
URLs cannot be used as filesystem symlink targets. Provider-to-mount matching is
manual. Keep one writer per export root, back up the private manifest and links,
and disable automatic scanner trash removal while mounts can be unavailable.

The exporter checks source confinement, rejects output-directory symlinks, keeps
existing files on collisions, and removes only its own links. Plex/Jellyfin account
permissions are separate from app user/profile permissions.

[Real scanner validation](https://github.com/Installation-04/StreamRD/blob/main/docs/media-library-validation.md)
verified movie/episode discovery and original-byte reads in Plex 1.43.5.11079 and
Jellyfin 10.10.7. No real debrid mounts or external metadata matching were tested.
