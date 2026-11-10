# Getting started

You need Docker with Compose, a persistent data volume, and your own supported
debrid account. Phosphor additionally needs a Jackett/Prowlarr Torznab endpoint.
The production containers use Node 22; direct development uses the committed npm
lockfiles in each server/web directory.

## Quick install

With Docker and the Compose plugin, one command installs the all-in-one container
(StreamRD on port 8080, Phosphor on 8081, plus qBittorrent) into `~/streamrd`:

```bash
curl -fsSL https://raw.githubusercontent.com/Installation-04/StreamRD/main/get.sh | bash
# pin a release and choose ports / the first administrator:
curl -fsSL https://raw.githubusercontent.com/Installation-04/StreamRD/main/get.sh | bash -s -- --version v0.8.1 --port 9090 --admin-email you@example.com
```

It uses the published image for a release (or builds from source), generates its own
secrets inside the data volume, never overwrites your settings or data, and updates in place when
re-run. `--uninstall` removes the container and keeps the data. It does not install Docker, set up
HTTPS or open ports; read [get.sh](https://github.com/Installation-04/StreamRD/blob/main/get.sh)
before piping any script to a shell. The sections below describe the older split-service install.

## Install (split services)

```bash
git clone https://github.com/Installation-04/StreamRD.git
cd StreamRD
git checkout v0.2.0
# Choose ONE product's directory:
cd infra                      # StreamRD
# cd phosphor/infra            # Phosphor, from the repository root
sudo ./install.sh
```

On Debian/Ubuntu the installer installs Docker if necessary, chooses available
host ports, creates a private `.env` with a random signing key on first install,
and starts the backend and web services. It prints their URLs. Existing `.env`
files are preserved on rerun. Port flags apply only to the first installation;
edit an existing configuration explicitly.

For manual deployment, from the chosen infra directory:

```bash
cp ../server/.env.example .env
chmod 600 .env
# Edit JWT_SECRET: use the output of openssl rand -hex 32.
# Set API_BASE_URL to the API URL your browser can reach.
docker compose up -d --build backend web
```

StreamRD defaults to http://localhost:3000; Phosphor to http://localhost:3100.
For LAN access replace localhost in `API_BASE_URL` with the server's LAN address
before building. Browser API URLs are build-time settings. Open the web URL and
sign up. The first account becomes admin unless `ADMIN_EMAIL` reserves that role;
restrict initial access until your administrator is created. Accounts are separate
between the two products.

## Configure

StreamRD: add provider keys under Account → Debrid, then add titles and sources
under Admin → Catalog. Optional open-movie demo metadata:

```bash
docker compose exec backend node dist/prisma/seed.js
```

Even a direct source link is resolved through a configured provider; the demo
catalog is not a bypass for missing debrid credentials.

Phosphor: add provider keys under Account → Debrid, then add your Torznab URL and
indexer key under Admin → Indexers. Test the indexer, then search and add results.

For HTTPS, use the repository's Caddy/Nginx examples and rebuild the web client
with the public API URL. A VPN/LAN deployment is also supported. Full deployment
instructions: [StreamRD](https://github.com/Installation-04/StreamRD/blob/main/docs/deployment.md)
and [Phosphor](https://github.com/Installation-04/StreamRD/blob/main/phosphor/docs/deployment.md).

Existing installations must read [Operations and recovery](https://github.com/Installation-04/StreamRD/wiki/Operations-and-recovery)
before upgrading to the non-root images.
