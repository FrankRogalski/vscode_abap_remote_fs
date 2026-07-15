---
"vscode-abap-remote-fs": minor
---

Add an MCP-driven "working transport" selection. Like the AI current-transport feature, but instead of pre-setting a default, the connected MCP client is asked (via elicitation) to pick a transport when an AI/MCP tool creates an object or edits one for the first time. The choice is remembered per connection for the rest of the session so a single AI turn only prompts once. A new MCP tool `select_working_transport` (actions `select` / `status` / `clear`) lets the user pick, inspect, or reset it explicitly. Clients that do not support elicitation transparently fall back to the normal interactive prompt.
