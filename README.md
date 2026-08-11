# Evidence for the security PR

Terminal captures backing
[the fail-closed security PR](https://github.com/AndrewYin04/fungible/pull/1).

**Evidence only — not part of that PR and not for merging.**

| | |
|---|---|
| `tui-start.txt` | the TUI starting clean with real figures after the changes |
| `tui-setup-client-id-masked.txt` | the first-run wizard: 24 asterisks for a 24-character Plaid Client ID, and the value appears zero times in the whole capture |
| `rest-unauth.txt` | the REST API refusing an unauthenticated request |
| `mcp-http-unauth.txt` | the MCP transport doing the same on its own port |

This app is a TUI, so its evidence is terminal text rather than screenshots.
