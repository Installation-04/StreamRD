# Add-on connection controls

Captured from the production web build in the disposable local lab using
Google Chrome. `addon-connections.png` shows desktop controls;
`addon-connections-mobile.png` shows the same page at 390 pixels wide.
`download-client-sharing.png` and `download-client-sharing-mobile.png` show the
owner's explicit sharing choice after saving synthetic connection settings.

The connection-success message uses a synthetic response fixture to verify UI
feedback. It is not evidence that the pictured uninstalled apps were connected.
Real Sonarr/Radarr/Lidarr and qBittorrent compatibility is checked separately by
the complete-container CI job. No live accounts or credentials appear here.

`bundled-client-access.png` and `bundled-client-access-mobile.png` show the
owner's separate bundled-access permission and the required restart. The lab
simulates a supported named-bridge installation; it does not run qBittorrent.
Real listener opening, authentication, restarts and withdrawal are checked by
`infra/smoke-bundled-qbit.sh` in the complete-container CI job.
