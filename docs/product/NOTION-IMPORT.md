# Import the project tracker into Notion

A live Notion page could not be created from this session: no Notion connection or
accessible parent page is available. The bundled tracker is ready to import and
contains actual delivery states, ownership, acceptance criteria, and future work.

1. Create a page named **StreamRD Community — Product HQ** in your chosen workspace.
2. Use **Import → Text & Markdown** and select `PROJECT-HQ.md`.
3. Import `tasks.csv` as a database. Set `Status` to a Status property, and use
   select properties for `Priority`, `Milestone`, and `Owner` as desired.
4. Add a board grouped by Status, a table filtered by the current milestone, and
   a blocked-items view. Keep acceptance criteria visible during reviews.
5. Link the page to the repository and releases. Record the real Notion page URL
   in the repository tracker once created; no page URL is fabricated here.

The repository's [project tracker](https://github.com/Installation-04/StreamRD/blob/main/docs/product/PROJECT-HQ.md)
is the maintained source while Notion is unavailable. Subsequent status changes
are not automatically synchronized into an imported Notion database. Connecting
Notion and providing a parent-page URL allows a future session to create/update
that workspace directly using its normal access controls.

Do not put provider credentials, private indexer URLs, signing keys, or databases
in public tracking pages.
