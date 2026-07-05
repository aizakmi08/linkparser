# Linkparser

[![CI](https://github.com/aizakmi08/linkparser/actions/workflows/ci.yml/badge.svg)](https://github.com/aizakmi08/linkparser/actions/workflows/ci.yml)

Linkparser is a Next.js product intelligence tool that searches commerce results and extracts structured product data from URLs. It combines a simple web UI with API routes that call Firecrawl, normalize product names/prices/images, and optionally cache results in Convex.

## Features

- Paste a product URL and extract a normalized product name, display name, price, and primary image.
- Search for products, filter toward likely commerce pages, and extract product data from top results.
- Normalize messy retailer titles into short display names.
- Parse common currency symbols and price formats.
- Cache repeated requests in memory and optionally in Convex.
- Keep raw extraction payloads available for debugging.

## Tech Stack

- Next.js App Router
- TypeScript
- Firecrawl search and extraction APIs
- Convex for optional persistent caching
- Zod request validation

## Project Structure

```text
src/app/
|-- page.tsx              # Product URL extraction and search UI
`-- api/
    |-- extract/route.ts  # URL extraction, normalization, cache lookup/write-through
    `-- search/route.ts   # Commerce-oriented search and sequential product extraction

convex/
|-- schema.ts             # Product cache schema
`-- products.ts           # Product lookup/upsert functions
```

## Environment

Create `.env.local`:

```bash
FIRECRAWL_API_KEY=
CONVEX_URL=
```

`FIRECRAWL_API_KEY` is required. `CONVEX_URL` is optional; without it, the app still uses in-memory cache during the server process lifetime.

## Run Locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Convex Setup

To enable persistent caching:

```bash
npm run convex:once
```

Then keep Convex syncing in another terminal:

```bash
npm run convex:dev
```

## Notes

The API routes are intentionally defensive around third-party extraction output. They normalize data into a stable UI shape while preserving the raw payload for inspection.

## Quality Signals

- CI installs dependencies and runs the production build on pushes and pull requests.
- `CONTRIBUTING.md` documents the expected validation path for extraction, search, and cache changes.
- `SECURITY.md` captures expectations around API keys, external URL handling, and raw third-party payloads.
