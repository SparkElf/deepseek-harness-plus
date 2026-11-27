# @sparkelf/dsh-api-client

An Apifox-inspired official right-Sidebar API workbench for DeepSeek Harness 0.1.5 with compact SQL-Workbench-aligned typography, viewport-safe portal menus, custom searchable selects, request tabs, focused request editing, and a request/response split that adapts to the containing panel width.

## Current capabilities

- Persistent workspaces, nested collection contracts, environments, requests, and bounded response history.
- Method, URL, query parameter, header, authorization, body, environment, response, and history views.
- Basic, Bearer, API-key, and OAuth-token authorization resolved only inside the Host through the shared encrypted Workbench vault.
- Explicit browser Send action with 30-second timeout, HTTP(S)-only URLs, redirect handling, and a 2 MiB response-body limit.
- Cascading workspace, collection, environment, request, history, and secret deletion.
- Sanitized Send to conversation action plus non-secret api_list_requests, api_get_request, and api_prepare_request model tools.

Model tools cannot execute requests or retrieve secret environment/auth values. Request bodies support JSON, text, XML, form encoding, GraphQL, structured multipart parts, and Base64 binary data. A Host-side cookie jar replays matching response cookies. Workspaces import Postman Collection v2 or OpenAPI 3 JSON and export either format. Scripted hooks and AWS SigV4 are not included in this version.
