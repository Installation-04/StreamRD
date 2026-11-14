# Add-ons

**Admin → Add-ons** installs programs that people usually run next to a media server, each with one button. They start beside StreamRD, keep
their settings in their own folder under `config/`, and are updated, stopped and removed from the same page.

| Add-on | What it does | Port | Licence |
|---|---|---|---|
| Sonarr | Keeps TV shows in order and fetches new episodes | 8989 | GPL-3.0 |
| Radarr | Keeps movies in order and fetches the ones you ask for | 7878 | GPL-3.0 |
| Lidarr | Keeps music in order and fetches new albums | 8686 | GPL-3.0 |
| Bazarr | Finds subtitles for what Sonarr and Radarr manage | 6767 | GPL-3.0 |
| Seerr | People search and request a title with one click; it hands the request to Sonarr or Radarr | 5055 | MIT |
| Tautulli | Shows who watched what on Plex | 8181 | GPL-3.0 |
| Prowlarr | Keeps the list of indexers once and shares it | 9696 | GPL-3.0 |
| FlareSolverr | Lets Prowlarr reach indexers behind a browser check. Nothing to open: Prowlarr talks to it by name | none | MIT |
| Maintainerr | Rules that tidy the library, such as removing what nobody watches | 6246 | MIT |

They are separate programs made by other people. None of their code is part of StreamRD: the image of each is downloaded from its maker, on
your machine, when you press Install.

## Needs Docker control
Installing from the page needs Docker control, which the installer turns on by default (see [Plex and Jellyfin](https://github.com/Installation-04/StreamRD/blob/main/docs/plex-jellyfin.md#docker-control)).
Without it the page says what to run, and changes nothing.

## What each one is given
Decided in one place (`SERVERS` in `infra/single-container/media-manager.cjs`), never by the page and never by the request:

- its own settings folder, `config/<name>/` (Seerr: `config/seerr/config`, Maintainerr: `config/maintainerr/data`);
- Sonarr, Radarr, Lidarr and Bazarr also get StreamRD's `data/` folder with write access, at the same path StreamRD sees it, because they
  move and rename what they import. Nobody else gets it. The media servers still see it read-only;
- no add-on sees the libraries StreamRD exports, Docker's socket, or the machine's network stack;
- a port on the machine, except FlareSolverr, which only the other containers can reach.

## Install, stop, start, remove
- **Install** downloads the image (a log box follows it) and starts the add-on. The port can be chosen first, 1024 to 65535.
- **Stop** keeps it from running; **Start** brings it back. Whether it starts again when the machine restarts is a checkbox on its card.
- **Remove** removes the container. Its settings stay under `config/`, so installing it again picks up where it was.
- **Updates**: each installed add-on has *Check for updates* and *Update now* on its card, and an optional night update, as on Admin → System.
  An update downloads the image its fixed reference points to now and, if it is newer, restarts the add-on on it; the previous version is put back
  if the new one does not start. A new version of a program can change its own database in a way an older one cannot read: copy its folder under
  `config/` first if what it holds matters.

## Sign-in and links
A minute or two after Sonarr, Radarr, Lidarr or Prowlarr runs, StreamRD gives it a login it made up (kept encrypted; **Show login** on the card) and tells Prowlarr about every Sonarr, Radarr and Lidarr that runs. An add-on whose login someone already chose is left alone.

**Connect add-ons** runs that check immediately and reports connection errors or
apps that are still starting. **Download client settings** opens the qBittorrent
connection configured under Admin → Request settings.

The connection's owner must check **Allow installed add-ons to use this
connection** in Download settings and save. This is off by default, including
for existing connections. Other administrators cannot enable it for the owner.
When the connection is enabled, opted in and its owning administrator is still
active, StreamRD adds it to Sonarr, Radarr and Lidarr if they have no download clients.
Existing clients, including disabled ones, are left alone. Each app gets its own
`streamrd-sonarr`, `streamrd-radarr` or `streamrd-lidarr` category; automatic removal
of completed and failed downloads is disabled. Host, port, HTTPS and a reverse-proxy
URL base come from the saved connection. Credentials stay out of linking reports
and logs, and are rechecked before being sent to the add-on.

Opting in sends credentials to those apps, which other server administrators
can access. Turning sharing off stops new configurations; it preserves existing
add-on connections and does not revoke credentials already copied to them.
Resetting the saved connection clears its sharing permission. Sharing choices
do not change the fingerprints used to track existing request transfers.

Use a qBittorrent URL reachable from the add-on containers. Loopback and wildcard
addresses are reported as waiting unless the bundled-client option below applies.

### Bundled qBittorrent

The bundled client stays local by default. On a single-container installation
with Docker control and **one named Docker bridge network**, its connection owner can:

1. Configure and enable `http://127.0.0.1:8082` using the bundled credentials.
2. Approve **Allow installed add-ons to use this connection**.
3. Check **Allow add-ons to reach the bundled client after restart** and save.
4. Restart from **Admin → System**, then connect the add-ons.

Saving permission alone does not change the running listener. Download settings
shows current access and whether a restart is required. After restart, the client
accepts authenticated connections from its Docker network; port 8082 is not
published on the host. Add-ons use StreamRD's stable container name, while local
requests continue using the saved loopback address. The container name must stay
the same across updates. Authentication and host validation remain enabled.

To close access, withdraw bundled permission (or sharing approval), save, and
restart. Resetting the connection also withdraws permission. Existing add-on
settings and torrents are preserved. Credential copies already sent to add-ons
are not revoked. Default bridge, host, multiple networks and other network modes leave this option
unavailable; use a reachable external client or change the installation's network.

## Not done yet
Root folders, FlareSolverr in Prowlarr, and Bazarr,
Seerr, Tautulli and Maintainerr setup remain open. A successful connection test
does not establish successful downloading or importing of media.
