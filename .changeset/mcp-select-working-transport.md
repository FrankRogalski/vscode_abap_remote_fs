---
"vscode-abap-remote-fs": minor
---

Ask the user for the transport request through the MCP client. When an AI/MCP tool creates an object or edits a transportable object that is not yet locked into a transport, the connected MCP client prompts the user (via elicitation) to pick one of the transports SAP proposes for that object. Nothing is remembered — every write that needs a transport asks again. MCP writes never fall back to the VS Code prompt: if the user declines or the client does not support elicitation, the write fails with an explanatory error. Non-MCP flows (VS Code Copilot, manual edits) keep the normal interactive prompt.
