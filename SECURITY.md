# Security

Hermes Mobile is a local bridge. It is designed to keep Hermes backend tokens inside the Node server and proxy browser requests through same-origin `/hermes-backend/*` routes.

Do not commit backend descriptor files, `.env` files, or generated workspace directories. Descriptor files may contain API keys or session tokens.

Report security issues privately to the repository owner instead of opening a public issue.
