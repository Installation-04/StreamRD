# Import the project tracker into Notion

A private live progress home and delivery database were created for v0.27.0.
They include 17 initial work items, an inline status board and a needs-attention
view, with source evidence and next actions. The private link is in the project
chat; it is not published here. Updating the repository does not automatically
update Notion, or vice versa.

To create a separate tracker in another workspace, the bundled Markdown and CSV
remain available to import:

1. Create a page named **StreamRD Community — Product HQ** in your chosen workspace.
2. Use **Import → Text & Markdown** and select `PROJECT-HQ.md`.
3. Import `tasks.csv` as a database. Set `Status` to a Status property, and use
   select properties for `Priority`, `Milestone`, and `Owner` as desired.
4. Add a board grouped by Status, a table filtered by the current milestone, and
   a blocked-items view. Keep acceptance criteria visible during reviews.
5. Link the page to the repository and releases. Share its URL only with the
   intended audience; keep private workspace links out of public documentation.

The repository's [project tracker](https://github.com/Installation-04/StreamRD/blob/main/docs/product/PROJECT-HQ.md)
is the public delivery record. Subsequent status changes are not automatically
synchronized into an imported Notion database. Use the existing live tracker
rather than creating another copy during a continuation session.

Do not put provider credentials, private indexer URLs, signing keys, or databases
in public tracking pages.
