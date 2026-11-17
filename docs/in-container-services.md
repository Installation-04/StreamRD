# Services inside the StreamRD container

**Goal.** One container, one port, one compose file. StreamRD installs and runs the programs a debrid media setup needs (Zurg and its mount, Zilean and its database, then media servers and library tools) as ordinary processes inside its own container, so they all see the same files and the Real-Debrid mount with no Docker socket and no mount-sharing tricks. The page keeps a guided setup, status, logs and each program's own page.

**Where the idea comes from.** The all-in-one design of DUMB (https://github.com/I-am-PUID-0/DUMB). That project is GPL-3.0 and StreamRD is MIT, so this is a fresh implementation of the idea; **no DUMB code is copied**.

## Pieces
1. **Supervisor** (`infra/single-container/supervisor.cjs`): a registry of services, start order from dependencies, readiness checks, restarts with a limit, logs with secrets hidden. Knows nothing about any one program.
2. **Installer for a program**: downloads a release (checked size and checksum, right CPU), unpacks into the settings folder, writes its config. Later.
3. **Mount**: rclone in the container with `/dev/fuse` and `SYS_ADMIN`. Later; the installer and compose file add those for new installs, and the page says what is missing for old ones.
4. **Guided setup page**: pick what you want ("my Real-Debrid library with Jellyfin"), see the plan, press Apply. Later.

## Order of work (each its own small release; nothing existing is removed)
1. Supervisor core (this release). Not yet used by anything.
2. Wire it to the Docker helper's API and the Monitor page.
3. Release downloader, then Zurg and the rclone mount in the container.
4. Zilean and its database.
5. Jellyfin and Plex, then Prowlarr, Sonarr and Radarr, then Seerr and Bazarr.
6. Guided setup page.

The Docker-based installs stay as the fallback until the in-container ones are proven on real machines. A service already installed the Docker way is left alone.
