# Vendored fonts

The renderer's CSP is `font-src 'self' data:`, so the two faces the interface
uses are bundled here rather than fetched at runtime. Only the latin subset is
included.

| Family | Weights | Upstream |
| --- | --- | --- |
| Inter | 100–900 (variable) | https://rsms.me/inter/ |
| JetBrains Mono | 400, 500, 700 | https://fonts.google.com/specimen/JetBrains+Mono |

Inter sets the interface; JetBrains Mono sets anything that is data or code —
grid cells, column names, the SQL editor. Both are licensed under the SIL Open
Font License 1.1 (https://openfontlicense.org). `@font-face` declarations live
in `src/renderer/src/styles/index.css`.
