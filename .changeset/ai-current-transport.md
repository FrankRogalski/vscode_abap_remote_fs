---
"vscode-abap-remote-fs": minor
---

Add a per-connection "current transport" that AI/MCP-created objects and objects edited for the first time are auto-assigned to, skipping the transport prompt. Set or clear it via the new **ABAP FS: Set current transport** / **Clear current transport** commands, the `abapfs.currentTransport` setting, or the new status bar item (click to change/clear). Clearing it restores the ask-every-time behaviour.
