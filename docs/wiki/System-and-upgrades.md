# System and safe upgrades

Version **v0.4.0** introduces versioned SQLite migrations for both StreamRD and
Phosphor. Existing exact v0.1 and v0.2/v0.3 schemas are supported; customized,
partial or inconsistent databases need review before upgrading.

Open **Admin → System** to see the installed release, Node runtime, database
availability, independent migration readiness and optional media configuration.
Refresh fetches a new inspection. Only administrators can access this information;
the page does not modify migrations or expose credentials and database paths.

| State | Meaning |
|---|---|
| Current | Known migration history and schema agree with this release |
| Unmanaged | No migration history; inspect the supported baseline before adoption |
| Pending | A known checkpoint has additional committed migrations to apply |
| Failed | Incomplete or rolled-back history requires operator review |
| Drifted | History, checksums or database structure do not agree |
| Unavailable | Inspection could not establish readiness |

The snapshot panel describes policy, not proof that your installation has a
verified backup. Before changing an existing nonempty database, preparation writes
and verifies a unique private SQLite snapshot beside it. Restarting an already
current database is a no-op. Keep an off-host copy and test recovery.

Stop every writer before an upgrade. Read the complete
[database upgrade and recovery guide](https://github.com/Installation-04/StreamRD/blob/v0.4.0/docs/database-upgrades.md)
for Compose commands, ownership, controlled startup, inspection exit codes,
interruption recovery and migration maintenance. Production startup no longer
uses schema push. PostgreSQL is not supported by this release.

Plex/Jellyfin exports remain optional. Their symlinks still require real mounted
files readable by the scanner and an appropriate shared mount path. Database
readiness does not establish provider playback or scanner reachability.

See [screenshots](https://github.com/Installation-04/StreamRD/wiki/Screenshots)
and [Operations and recovery](https://github.com/Installation-04/StreamRD/wiki/Operations-and-recovery).
