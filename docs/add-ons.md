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
Installing from the page needs Docker control, which the installer turns on by default (see [Plex and Jellyfin](plex-jellyfin.md#docker-control)).
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

When that connection is enabled and its owning administrator is still active,
StreamRD adds it to Sonarr, Radarr and Lidarr if they have no download clients.
Existing clients, including disabled ones, are left alone. Each app gets its own
`streamrd-sonarr`, `streamrd-radarr` or `streamrd-lidarr` category; automatic removal
of completed and failed downloads is disabled. Host, port, HTTPS and a reverse-proxy
URL base come from the saved connection. Credentials stay out of linking reports
and logs, and are rechecked before being sent to the add-on.

Use a qBittorrent URL reachable from the add-on containers. `localhost`, loopback
and wildcard addresses cannot identify StreamRD from another container, so those
connections are reported as waiting. The bundled qBittorrent client keeps its
loopback-only default; this integration does not expose it on the network.

## Not done yet
Bundled-client reachability, root folders, FlareSolverr in Prowlarr, and Bazarr,
Seerr, Tautulli and Maintainerr setup remain open. A successful connection test
does not establish successful downloading or importing of media.
