# Vendored fonts

The renderer's CSP is `font-src 'self' data:`, so the two faces the Modernist
design system calls for are bundled here rather than fetched at runtime. Only
the latin subset of each weight the UI actually uses is included.

| Family | Weights | Upstream |
| --- | --- | --- |
| Archivo | 400, 600, 800 | https://fonts.google.com/specimen/Archivo |
| JetBrains Mono | 400, 500, 700 | https://fonts.google.com/specimen/JetBrains+Mono |

Both are licensed under the SIL Open Font License 1.1
(https://openfontlicense.org). `@font-face` declarations live in
`src/renderer/src/styles/index.css`.
