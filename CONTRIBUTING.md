# Contributing to Linkparser

Linkparser is a Next.js product intelligence tool that combines product URL extraction, commerce-oriented search, normalization, validation, and optional Convex caching.

## Local Setup

```bash
npm install
npm run dev
```

Create `.env.local` with a Firecrawl API key before testing live extraction. Convex is optional for local cache persistence.

## Quality Bar

- Run `npm run build` before changes to routes, validation, or caching.
- Use `npm run lint` when working on lint cleanup or new code paths that should stay lint-clean.
- Keep third-party extraction responses normalized behind stable UI/API shapes.
- Preserve raw extraction payload access for debugging while avoiding leaked credentials.
- Update `README.md` when environment, caching, or extraction behavior changes.

## Pull Request Notes

Include the extraction/search flow affected, validation performed, and any cache/schema impact.
