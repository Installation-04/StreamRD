# Movies and shows only, plus Zilean and Zurg

## Only movies and shows from your accounts

Debrid accounts also hold games, software, music and books. StreamRD's library is for movies and shows, so
account scans now skip anything that is clearly something else, and **My library** can remove what was imported
before. Nothing is ever deleted from your debrid account.

How a title is judged (from its name only, never the network):

- **Kept:** names with release tags that only video releases carry (`1080p`, `BluRay`, `WEB-DL`, `x265`, `S01E02`, …),
  and plain titles with no warning signs. A wrongly skipped movie is worse than a stray extra, so doubtful names stay.
- **Skipped:** game and console names (Xbox, PS4, Nintendo Switch, FitGirl/DODI repacks, `PC Games Collection`…), software
  (Adobe, Windows ISOs, keygens, `Setup.exe`…), music (`Discography`, `MP3 320kbps`), books and courses (ebooks, Udemy…),
  archives and other files, and names with no readable title, such as a bare 32-character hash.
- *The Hunger Games*, *Game of Thrones* and *Steam Boy* are movies/shows and are kept; their release tags or words
  decide, not a single keyword.

In **My library**, the panel's **Check my library for non-movie titles** lists what it would remove (counts by reason and
examples) and only removes them after you confirm. Removed names are skipped by later scans too, so they stay gone.

## Zilean (an indexer of Debrid Media Manager's cached torrents)

[Zilean](https://github.com/iPromKnight/zilean) keeps a searchable copy of Debrid Media Manager's public hash lists and
serves it as a Torznab feed, which Phosphor can search like Jackett or Prowlarr.

**From the page** (since v0.38.0): Admin → Add-ons → **Install Zilean** adds it, with its database, to an install that does not have it; StreamRD finds it by name, with nothing to set. **On by default for a new install** (since v0.30.0). Refuse it with `--no-zilean`; add it to an install that already exists with:

```bash
bash install.sh --zilean          # re-running is safe
```

This adds two containers to your Compose project, `zilean` and `zilean-db` (PostgreSQL 17), with their own named volumes and a
generated database password in `.env`. Phosphor registers **Zilean** as an indexer by itself (`ZILEAN_URL`); you can rename,
disable or delete it under **Admin → Indexers**, and it is not recreated if you do. Its first import of the hash lists runs
in the background and takes a while, so searches return nothing until it has finished. It needs outbound access to GitHub
and uses noticeable CPU, memory and disk while importing. Stop it with `bash install.sh --no-zilean`.

Verified here: the images start with the generated settings, Zilean applies its migrations, its Torznab capabilities and search
endpoints answer, Phosphor registers it and searches it without errors. **Not verified:** real search results (the import could not
download in the test environment), so result handling was hardened (Phosphor builds a magnet link from an info-hash) but not
exercised against real data. Zilean sets its own database connection from a string Compose provides; its docs do not describe this.

## Zurg (your Real-Debrid library as a mounted folder)

[Zurg](https://github.com/debridmediamanager/zurg-testing) turns a Real-Debrid account into a WebDAV share and rclone mounts it
as folders. StreamRD then reads real files from `/mnt/zurg` for its optional Plex/Jellyfin exports.

**From the page** (since v0.39.0): Admin → Add-ons → **Install Zurg** uses the Real-Debrid key stored for your account, creates `zurg` and `zurg-rclone` and mounts the library at `mnt/zurg` next to the settings folder; Plex and Jellyfin started from the page afterwards see it. StreamRD's own library export from the mount still needs the installer. **Turned on by a Real-Debrid token** (since v0.30.0): the Default install asks for it (Enter skips), and `--rd-token` on a new install turns Zurg on with no other option. If the machine cannot do the FUSE mount, a Zurg that was only switched on this way is skipped with a message and everything else is installed; `--zurg` by name still stops with the reason. `--no-zurg` keeps it off. To add it later:

```bash
bash install.sh --zurg --rd-token YOUR_REAL_DEBRID_API_TOKEN
```

- **Free build, Real-Debrid only.** AllDebrid, Premiumize and the other providers need Zurg's sponsor build, which this does not set up.
- **Linux host only** (needs `/dev/fuse`, which the installer installs FUSE for when it is missing, and mount propagation, which it sets up through sudo; Docker Desktop on Windows/macOS is not supported). The mount folder
  `./mnt/zurg` must be a shared mount; `install.sh` does this itself (through sudo when you are not root; if neither works it prints the two commands). This does not survive a
  host reboot by itself: add `mount --bind` and `mount --make-rshared` for that folder to a boot-time unit before the containers start.
- **Movies and shows only.** `zurg/config.yml` defines two directories: `shows` (has episodes) and `movies`, each requiring a video file and
  excluding obvious games, software, music and courses. Edit it freely and apply with `docker compose restart zurg`. The file holds your
  token and is mode 600; it is not overwritten on later runs.
- Your token is a secret: do not paste it in logs or issues. When running Zurg on a server outside your home network, uncheck
  "Use my Remote Traffic automatically when needed" on the Real-Debrid account page, as Zurg's documentation advises.

Verified here: the generated Compose file and Zurg config are valid, the mount folder is prepared as a shared mount, the Zurg image starts and
loads the config, and an existing config is kept. **Not verified:** a real Real-Debrid library, the rclone FUSE mount and its propagation into
the StreamRD container, and that Zurg's filters sort a real library as intended. Treat Zurg as experimental until you have seen it work on your host.
Zurg is a separate project with its own terms; check them before use.
