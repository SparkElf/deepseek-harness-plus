# dsh-sql-workbench

A Navicat-style SQL workbench for DeepSeek Harness. It runs as an independent npm plugin and contributes one Database page type to the official DSH right Sidebar.

## Features

- Right-side Navicat layout: connection selector, object tree, query tabs, SQL editor, and result grid.
- SQLite 3.x, PostgreSQL 12-18, MySQL 5.7/8.0/8.4, MariaDB 10.6/10.11/11.x, Apache Doris 2.x/3.x, and Oracle 12c-23ai connections.
- Latest pg 8.23 and mysql2 3.24 drivers; Oracle uses oracledb 7 Thin mode without requiring Oracle Client.
- Database, schema, table, view, and column discovery.
- Single-click database/object details and double-click server-paginated data preview.
- Clickable column sorting, per-column parameterized filters, total row count, page navigation, and page-size controls.
- Query drafts scoped to each DSH conversation.
- One default current query per conversation.
- Saved query library and editable working copies.
- Context menus for adding databases, tables, views, saved queries, and drafts to the conversation.
- AI tools that create a draft, keep editing the current draft by default, inspect catalogs, and execute SQL.
- Official right Sidebar push, fullscreen, split-pane, and floating-tab presentations.
- Chinese and English UI following the active DSH locale.

## Install

Requires DSH 0.2.1-alpha.2 or newer. The DSH peers are ranges rather than exact pins, so a
newer runtime satisfies them without republishing this plugin.

    dsh plugin --profile web add @sparkelf/dsh-sql-workbench@0.6.0

Restart dsh web, refresh the browser, expand the right Sidebar, then choose Database from its Guide.

### Install from this checkout

    pnpm install
    pnpm run build
    dsh plugin --profile web add file:/absolute/path/to/dsh-sql-workbench

## User workflow

1. Open the Database tab and add a connection.
2. Browse the object tree or right-click a table or view to create a query.
3. Run SQL and inspect the result grid.
4. Save a draft when it should become a saved query.
5. Right-click a database, table, view, draft, or saved query and choose Add to conversation.
6. Ask the model to generate SQL for a connection. The model creates an unsaved draft and makes it current.
7. Follow-up requests modify that same current draft unless the user explicitly requests a new query.

Opening a saved query creates a working copy. Model edits change the working copy. Only the UI Save command updates the saved query.

## AI tools

- sql_list_connections
- sql_list_catalog
- sql_get_current_query
- sql_create_query
- sql_update_current_query
- sql_run_query

sql_update_current_query always addresses the current query of the calling conversation. sql_create_query replaces that default only when a new draft is explicitly created.

## Persistence

The plugin stores non-secret connection metadata, saved queries, drafts, and conversation-to-current-query bindings in:

    ~/.dsh/sql-workbench.json

Passwords are encrypted with AES-256-GCM in `~/.dsh/sql-workbench-secrets.json`. The independent key is stored in `~/.dsh/sql-workbench-secrets.key`; both files are created with mode `0600`. Passwords are never returned through browser state or model tools. Existing plaintext passwords are migrated automatically on first load.

Recent query results, object details, and preview pages live in the running DSH process and are scoped by conversation.

## Development

    pnpm install
    pnpm run typecheck
    pnpm run build

The browser bundle follows the DSH module-loader contract and inlines CodeMirror, Zustand, and the workbench UI. React and Cordis resolve from the DSH client module table. The host half exposes /dsh-sql-workbench/api/* and /dsh-sql-workbench/ws.

## License

MIT
