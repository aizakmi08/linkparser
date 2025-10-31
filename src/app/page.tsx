"use client";

import { useState, useCallback } from "react";

type ExtractResult = {
	productName?: string;
	shortName?: string | null;
	displayName?: string | null;
	price?: number | string | null;
	priceUsd?: number | null;
	imageUrl?: string | null;
	raw?: unknown;
};

export default function Home() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExtractResult | null>(null);

  // New: search state
  const [query, setQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [links, setLinks] = useState<Array<{ title?: string | null; url: string; snippet?: string | null; productName?: string | null; displayName?: string | null; price?: number | string | null; imageUrl?: string | null; extracting?: boolean }>>([]);

  const onSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to extract");
      setResult({
        productName: data.productName,
        shortName: data.shortName,
        displayName: data.displayName,
        price: data.price,
        priceUsd: data.priceUsd,
        imageUrl: data.imageUrl,
        raw: data.raw,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [url]);

  // New: product search + sequential extraction
  const onSearch = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setSearchLoading(true);
    setSearchError(null);
    setLinks([]);
    try {
      // Fetch up to 4 product links (commerce/product pages) fast
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, numResults: 12, extractProductInfo: false }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Search failed");

      const initial = (data.results || []).slice(0, 4);
      setLinks(initial.map((l: any) => ({ ...l, extracting: true })));
      setSearchLoading(false);

      // Sequentially extract info for each link, updating UI as we go
      for (const item of initial as Array<{ url: string }>) {
        try {
          const ex = await fetch("/api/extract", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: item.url }),
          });
          const exData = await ex.json();
          setLinks((prev) =>
            prev.map((l) =>
              l.url === item.url
                ? {
                    ...l,
                    productName: exData.productName ?? l.productName ?? null,
                    displayName: exData.displayName || exData.productName || l.displayName || l.title || null,
                    price: exData.price ?? l.price ?? null,
                    imageUrl: exData.imageUrl ?? l.imageUrl ?? null,
                    extracting: false,
                  }
                : l
            )
          );
        } catch {
          setLinks((prev) => prev.map((l) => (l.url === item.url ? { ...l, extracting: false } : l)));
        }
      }
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Unknown error");
      setSearchLoading(false);
    }
  }, [query]);

  return (
    <div style={{ maxWidth: 680, margin: "40px auto", padding: 16 }}>
      <h1 style={{ marginBottom: 16 }}>Product info extractor</h1>
      <form onSubmit={onSubmit} style={{ display: "flex", gap: 8 }}>
        <input
          type="url"
          placeholder="Paste a product URL (any store or marketplace)"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
          style={{ flex: 1, padding: 10, fontSize: 16 }}
        />
        <button type="submit" disabled={loading} style={{ padding: "10px 16px" }}>
          {loading ? "Extracting…" : "Extract"}
        </button>
      </form>
      {error && (
        <p style={{ color: "crimson", marginTop: 12 }}>Error: {error}</p>
      )}
      {result && (
        <div style={{ marginTop: 24 }}>
          {result.imageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={result.imageUrl}
              alt={result.productName || "Product image"}
              style={{ maxWidth: "100%", height: "auto", marginBottom: 12 }}
            />
          )}
          <div style={{ lineHeight: 1.6 }}>
            <div>
              <strong>Name:</strong>{" "}
              {result.displayName || result.productName || result.shortName || "(not found)"}
            </div>
            <div>
              <strong>Price:</strong>{" "}
              {typeof result.price === "number" ? `$${result.price}` : (result.price || "(not found)")}
            </div>
          </div>

          {result.raw && (
            <details style={{ marginTop: 16 }}>
              <summary>Debug: raw Firecrawl response</summary>
              <pre style={{ whiteSpace: "pre-wrap", background: "#f6f6f6", padding: 12, borderRadius: 6 }}>
                {JSON.stringify(result.raw, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}

      <hr style={{ margin: "32px 0" }} />
      <h2 style={{ marginBottom: 12 }}>Search products to buy (Firecrawl Search)</h2>
      <form onSubmit={onSearch}>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <input
            type="text"
            placeholder="e.g., iPhone 17 Pro Max"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            required
            style={{ flex: 1, padding: 10, fontSize: 16 }}
          />
          <button type="submit" disabled={searchLoading} style={{ padding: "10px 16px" }}>
            {searchLoading ? "Searching…" : "Search"}
          </button>
        </div>
      </form>
      {searchError && <p style={{ color: "crimson", marginTop: 12 }}>Error: {searchError}</p>}
      {links.length > 0 && (
        <ul style={{ marginTop: 16, paddingLeft: 18, listStyle: "none" }}>
          {links.map((l) => (
            <li key={l.url} style={{ marginBottom: 24, padding: 16, border: "1px solid #ddd", borderRadius: 8 }}>
              <div style={{ display: "flex", gap: 12 }}>
                {l.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={l.imageUrl}
                    alt={l.displayName || l.productName || "Product"}
                    style={{ width: 120, height: 120, objectFit: "cover", borderRadius: 6 }}
                  />
                ) : l.extracting ? (
                  <div
                    style={{
                      width: 120,
                      height: 120,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      border: "1px solid #ddd",
                      borderRadius: 6,
                      color: "#666",
                      fontSize: 12,
                    }}
                  >
                    Loading...
                  </div>
                ) : null}
                <div style={{ flex: 1 }}>
                  <div style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
                    <a href={l.url} target="_blank" rel="noreferrer" style={{ fontWeight: 600, fontSize: 16 }}>
                      {l.displayName || l.productName || l.title || l.url}
                    </a>
                    {l.extracting && (
                      <span style={{ fontSize: 12, color: "#666", fontStyle: "italic" }}>
                        Extracting info...
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(l.url);
                        } catch {}
                      }}
                      style={{ marginLeft: 10, padding: "4px 8px", fontSize: 12 }}
                    >
                      Copy link
                    </button>
                  </div>
                  {l.price && (
                    <div style={{ fontSize: 18, fontWeight: 600, color: "#2563eb", marginBottom: 4 }}>
                      {typeof l.price === "number" ? `$${l.price}` : l.price}
                    </div>
                  )}
                  {l.snippet && (
                    <div style={{ color: "#555", fontSize: 13, marginTop: 4 }}>{l.snippet}</div>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
