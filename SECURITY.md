# Security Policy

## Supported Version

Security fixes target the current `master` branch.

## Reporting

Please do not publish sensitive security details in a public issue. Use GitHub's private vulnerability reporting when available, or contact the maintainer through the GitHub profile with a short summary and reproduction outline.

## Security Notes

- Do not commit Firecrawl keys, Convex deployment credentials, or local `.env` files.
- Validate and normalize external URLs before passing them to extraction services.
- Treat raw extraction payloads as untrusted third-party data.
- Keep API route error messages useful without exposing provider secrets or internal stack traces.
