import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../../convex/_generated/api";

export const runtime = "nodejs";

type SearchResult = {
	title?: string | null;
	url: string;
	snippet?: string | null;
	productName?: string | null;
	displayName?: string | null;
	price?: number | string | null;
	imageUrl?: string | null;
};

function isCommerceUrl(urlStr: string): boolean {
    try {
        const u = new URL(urlStr);
        const host = u.hostname.toLowerCase();
        const allowHosts = [
            // General marketplaces / big retailers
            "amazon.com", "www.amazon.com",
            "walmart.com", "www.walmart.com",
            "bestbuy.com", "www.bestbuy.com",
            "target.com", "www.target.com",
            "ebay.com", "www.ebay.com",
            "aliexpress.com", "www.aliexpress.com",
            "etsy.com", "www.etsy.com",
            "newegg.com", "www.newegg.com",
            "bhphotovideo.com", "www.bhphotovideo.com",
            "microcenter.com", "www.microcenter.com",
            "costco.com", "www.costco.com",
            "samsclub.com", "www.samsclub.com",
            "ikea.com", "www.ikea.com",
            "wayfair.com", "www.wayfair.com",
            "sephora.com", "www.sephora.com",
            "ulta.com", "www.ulta.com",
            "nike.com", "www.nike.com",
            "adidas.com", "www.adidas.com",
            "apple.com", "www.apple.com",
            "store.google.com",
            "samsung.com", "www.samsung.com",
            "hp.com", "www.hp.com",
            "dell.com", "www.dell.com",
            "lenovo.com", "www.lenovo.com",
        ];
        if (allowHosts.includes(host)) return true;
        if (/\b(store|shop)\b/.test(host)) return true;
        // Heuristics: paths that look like product detail pages
        const p = u.pathname.toLowerCase();
        if (/\/dp\//.test(p) || /\/gp\/product\//.test(p)) return true; // Amazon style
        if (/\/product\//.test(p) || /\/p\//.test(p) || /\/sku\//.test(p)) return true;
        if (/add-to-cart|cart|checkout/.test(p)) return true;
        // Titles often contain keywords like "buy", "add to cart" but we don't have title here
        return false;
    } catch {
        return false;
    }
}

function isProductDetailPage(urlStr: string): boolean {
    try {
        const u = new URL(urlStr);
        const p = u.pathname.toLowerCase();
        // Strong indicators of product detail pages
        if (/\/dp\/[^\/]+/.test(p)) return true; // Amazon /dp/B08XXX
        if (/\/gp\/product\/[^\/]+/.test(p)) return true; // Amazon /gp/product/B08XXX
        if (/\/product\/[^\/]+/.test(p)) return true; // Generic /product/XXX
        if (/\/p\/[^\/]+/.test(p)) return true; // Generic /p/XXX
        if (/\/sku\/[^\/]+/.test(p)) return true; // SKU pages
        if (/\/t\/[^\/]+\/[^\/]+/.test(p)) return true; // Nike style /t/product-name/code
        if (/\/item\/[^\/]+/.test(p)) return true; // eBay style /item/123456
        if (/\/\d+\.html/.test(p)) return true; // Some sites use /12345.html
        // Multi-segment that isn't category/search/shop
        if (/\/[^\/]+\/[^\/]+\/[^\/]+/.test(p) && !/^(category|search|shop|collection|browse)/.test(p.split('/')[1])) return true;
        return false;
    } catch {
        return false;
    }
}

function validateSpecificQuery(query: string): { valid: boolean; error?: string } {
    const q = query.trim().toLowerCase();
    const tokens = q.split(/\s+/).filter(Boolean);
    
    // Require at least 2 meaningful words
    if (tokens.length < 2) {
        return { valid: false, error: "Please be more specific. Include brand and model (e.g., 'iPhone 15 Pro Max' or 'Nike Phantom 6 Elite')" };
    }
    
    // Check for generic single-word queries (common product categories)
    const generic = new Set(["bed", "chair", "table", "lamp", "phone", "laptop", "shoes", "cleats", "shirt", "pants", "jacket", "watch", "headphones", "camera"]);
    if (tokens.length === 1 && generic.has(tokens[0])) {
        return { valid: false, error: "Please specify brand and model (e.g., 'iPhone 15 Pro' not just 'phone', 'Nike Phantom 6' not just 'cleats')" };
    }
    
    // For tech products, prefer queries with model numbers or brand + model words
    const techKeywords = ["iphone", "samsung", "ipad", "macbook", "airpods", "watch", "laptop", "phone", "tablet"];
    const hasTech = techKeywords.some(kw => q.includes(kw));
    if (hasTech) {
        // Check if it has a number (model number) or brand + at least one more word
        const hasNumber = /\d+/.test(q);
        const hasBrand = /^(apple|samsung|google|oneplus|xiaomi|huawei|sony|lg)/.test(q);
        // Allow if it has a model number (e.g., "iPhone 15") or brand + 2+ words
        if (!hasNumber && tokens.length < 3) {
            return { valid: false, error: "Please include model number or brand + model (e.g., 'iPhone 15 Pro Max' not just 'iPhone')" };
        }
    }
    
    // For shoes/cleats, require brand + model
    const shoeKeywords = ["cleats", "shoes", "sneakers", "boots"];
    const hasShoe = shoeKeywords.some(kw => q.includes(kw));
    if (hasShoe && tokens.length < 3) {
        const hasBrand = /^(nike|adidas|puma|reebok|new balance|converse|vans|jordan)/.test(q);
        if (!hasBrand) {
            return { valid: false, error: "Please include brand and model (e.g., 'Nike Phantom 6 Elite' not just 'cleats')" };
        }
    }
    
    return { valid: true };
}

function prioritizeCommerce(results: SearchResult[]): SearchResult[] {
    // Keep order but move strong commerce hosts earlier
    const priorityHosts = [
        "www.amazon.com", "amazon.com",
        "www.bestbuy.com", "bestbuy.com",
        "www.walmart.com", "walmart.com",
        "www.target.com", "target.com",
        "www.ebay.com", "ebay.com",
        "www.newegg.com", "newegg.com",
    ];
    return results.sort((a, b) => {
        const ha = (() => { try { return new URL(a.url).hostname.toLowerCase(); } catch { return ""; } })();
        const hb = (() => { try { return new URL(b.url).hostname.toLowerCase(); } catch { return ""; } })();
        const ia = priorityHosts.indexOf(ha);
        const ib = priorityHosts.indexOf(hb);
        const sa = ia === -1 ? Number.MAX_SAFE_INTEGER : ia;
        const sb = ib === -1 ? Number.MAX_SAFE_INTEGER : ib;
        return sa - sb;
    });
}

function makeDisplayName(original: string): string {
    const primary = original.split(/\s+-\s+|:\s+|\|/)[0];
    const cleaned = primary.replace(/\s*([\[\(][^\]\)]*[\]\)])\s*/g, " ").replace(/\s+/g, " ").trim();
    const tokens = cleaned.split(/\s+/);
    const stop = new Set([
        "with","and","for","the","a","an","of","by","at","to","from","in","on","&","amp",
        "double","stainless","steel","insulation","dishwasher","safe","bpa","free","removable","bumper",
        "inch","inches","oz","ounce","ounces","ml","liter","litre","pack","set","new","bundle",
        "color","colour","size","large","small","medium","xl","xxl","mini",
    ]);
    const important: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        const plain = t.replace(/[^A-Za-z0-9\-]/g, "");
        if (!plain) continue;
        if (/^(GB|TB|cm|mm)$/i.test(plain)) continue;
        if (i >= 2 && stop.has(plain.toLowerCase())) continue;
        important.push(t);
        if (important.length >= 6) break;
    }
    if (important.length >= 2) return important.join(" ");
    return tokens.slice(0, Math.min(3, tokens.length)).join(" ");
}

async function fetchHtml(url: string): Promise<string | null> {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout
        try {
            const res = await fetch(url, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
                    "Accept-Language": "en-US,en;q=0.9",
                },
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            if (!res.ok) return null;
            return await res.text();
        } catch {
            clearTimeout(timeoutId);
            return null;
        }
    } catch {
        return null;
    }
}

function extractOgTag(html: string, property: string): string | null {
    // Try property first
    let re = new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, "i");
    let m = html.match(re);
    if (m?.[1]) return m[1];
    
    // Try name attribute as fallback
    re = new RegExp(`<meta[^>]+name=["']${property.replace("og:", "")}["'][^>]+content=["']([^"']+)["']`, "i");
    m = html.match(re);
    if (m?.[1]) return m[1];
    
    // For images, try twitter:image
    if (property === "og:image") {
        re = new RegExp(`<meta[^>]+(?:property|name)=["']twitter:image["'][^>]+content=["']([^"']+)["']`, "i");
        m = html.match(re);
        if (m?.[1]) return m[1];
    }
    
    return null;
}

function extractImageFromHtml(html: string): string | null {
    // Try og:image first (covers most cases)
    let imageUrl = extractOgTag(html, "og:image");
    if (imageUrl) return imageUrl;
    
    // Try JSON-LD structured data
    const jsonLdMatches = Array.from(html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi));
    for (const match of jsonLdMatches) {
        try {
            const jsonLd = JSON.parse(match[1]);
            const items = Array.isArray(jsonLd) ? jsonLd : [jsonLd];
            for (const item of items) {
                // Try image field
                if (item.image) {
                    if (typeof item.image === "string") return item.image;
                    if (typeof item.image === "object" && item.image.url) return item.image.url;
                    if (Array.isArray(item.image) && item.image[0]) {
                        const img = item.image[0];
                        if (typeof img === "string") return img;
                        if (typeof img === "object" && img.url) return img.url;
                    }
                }
                // Try thumbnailUrl
                if (item.thumbnailUrl && typeof item.thumbnailUrl === "string") return item.thumbnailUrl;
                // Try offers.image
                if (item.offers?.image) {
                    if (typeof item.offers.image === "string") return item.offers.image;
                }
            }
        } catch {}
    }
    
    // Try common image selectors (for product pages)
    const imageSelectors = [
        /<img[^>]+(?:id|class|data-src)=["'][^"']*(?:hero|main|primary|product-image|product-img|featured)[^"']*["'][^>]+src=["']([^"']+)["']/i,
        /<img[^>]+src=["']([^"']+)["'][^>]+(?:id|class|data-src)=["'][^"']*(?:hero|main|primary|product-image|product-img|featured)[^"']*["']/i,
        /data-image-src=["']([^"']+)["']/i,
        /data-src=["']([^"']+\.(?:jpg|jpeg|png|webp|gif))["']/i,
    ];
    
    for (const pattern of imageSelectors) {
        const match = html.match(pattern);
        if (match?.[1]) {
            const imgUrl = match[1];
            // Validate it looks like an image URL
            if (imgUrl.startsWith("http") && /\.(jpg|jpeg|png|webp|gif)/i.test(imgUrl)) {
                return imgUrl;
            }
        }
    }
    
    return null;
}

function extractTitle(html: string): string | null {
    const m = html.match(/<title>([^<]+)<\/title>/i);
    if (m?.[1]) return m[1].replace(/\s+/g, " ").trim();
    return null;
}

function extractPriceFromText(text: string): string | null {
    // Look for common price patterns: $123.45, $123, €99.99, £49.99, etc.
    // Prioritize prices with decimals or that look like actual product prices
    const patterns = [
        /\$[\d,]+\.\d{2}\b/,  // $123.45
        /\$\d{2,}[\d,]*\b/,   // $185, $1299
        /€[\d,]+\.\d{2}\b/,   // €99.99
        /£[\d,]+\.\d{2}\b/,   // £49.99
        /USD\s*[\d,]+\.\d{2}\b/i,  // USD 99.99
        /\$\s*[\d,]+\.\d{2}\b/,    // $ 123.45
    ];
    
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
            // Clean up the match
            let price = match[0].trim();
            // Remove spaces after $ sign
            price = price.replace(/\$\s+/, "$");
            // Ensure it's a reasonable price (between $1 and $1,000,000)
            const numericPart = price.replace(/[^0-9.]/g, "");
            const num = parseFloat(numericPart);
            if (num >= 1 && num <= 1000000) {
                return price;
            }
        }
    }
    return null;
}

function extractPriceFromHtml(html: string): string | null {
    // Try JSON-LD structured data first
    const jsonLdMatch = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
    if (jsonLdMatch) {
        try {
            const jsonLd = JSON.parse(jsonLdMatch[1]);
            if (jsonLd.offers?.price) {
                const price = jsonLd.offers.price;
                if (typeof price === "number") return `$${price.toFixed(2)}`;
                if (typeof price === "string") {
                    const num = parseFloat(price);
                    if (!isNaN(num)) return `$${num.toFixed(2)}`;
                }
            }
            if (jsonLd.price) {
                const price = jsonLd.price;
                if (typeof price === "number") return `$${price.toFixed(2)}`;
                if (typeof price === "string") {
                    const num = parseFloat(price);
                    if (!isNaN(num)) return `$${num.toFixed(2)}`;
                }
            }
        } catch {}
    }
    
    // Try meta tags
    const priceMeta = html.match(/<meta[^>]*property=["']product:price:amount["'][^>]*content=["']([^"']+)["']/i);
    if (priceMeta) {
        const num = parseFloat(priceMeta[1]);
        if (!isNaN(num) && num > 0) return `$${num.toFixed(2)}`;
    }
    
    // Try common price selectors (Amazon, eBay, etc.)
    const priceSelectors = [
        /id=["']price[^"']*["'][^>]*>\s*\$?\s*([\d,]+\.?\d*)/i,
        /class=["'][^"']*price[^"']*["'][^>]*>\s*\$?\s*([\d,]+\.?\d*)/i,
        /data-price=["']([^"']+)["']/i,
        /price["']?\s*:\s*["']?\$?([\d,]+\.?\d*)/i,
    ];
    
    for (const pattern of priceSelectors) {
        const match = html.match(pattern);
        if (match) {
            const num = parseFloat(match[1].replace(/,/g, ""));
            if (!isNaN(num) && num >= 1 && num <= 1000000) {
                return `$${num.toFixed(2)}`;
            }
        }
    }
    
    // Last resort: extract from visible text
    const textContent = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
    return extractPriceFromText(textContent);
}

// In-memory cache for product info (per request lifecycle)
const productInfoCache = new Map<string, { productName?: string | null; displayName?: string | null; price?: number | string | null; imageUrl?: string | null }>();

async function fetchProductInfo(url: string, apiKey: string, convexClient: ConvexHttpClient | null, snippet?: string | null): Promise<{ productName?: string | null; displayName?: string | null; price?: number | string | null; imageUrl?: string | null }> {
    // In-memory cache check first (fastest)
    const cached = productInfoCache.get(url);
    if (cached) return cached;
    
    // Check Convex cache
    if (convexClient) {
        try {
            const existing = await convexClient.query(api.products.getByUrl, { url });
            if (existing && existing.productName) {
                const result = {
                    productName: existing.productName || null,
                    displayName: existing.productName ? makeDisplayName(existing.productName) : null,
                    price: existing.price ?? null,
                    imageUrl: existing.imageUrl || null,
                };
                productInfoCache.set(url, result);
                return result;
            }
        } catch {}
    }
    
    // Extract via Firecrawl (only if not a product page, skip)
    try {
        const { default: Firecrawl } = await import("@mendable/firecrawl-js");
        const firecrawl = new Firecrawl({ apiKey });
        const schema = z.object({
            productName: z.string().describe("Product name/title"),
            price: z.union([z.string(), z.number()]).describe("Price as string or number"),
            imageUrl: z.string().optional().describe("Primary image"),
        });
        
        const extractPromise = firecrawl.extract({
            urls: [url],
            prompt: "Extract productName (title), price (formatted), imageUrl (main product image). Prefer buy box for price.",
            schema,
        });
        
        // Increase timeout to 12s for better success rate
        const result = await Promise.race([
            extractPromise,
            new Promise<any>((_, reject) => 
                setTimeout(() => reject(new Error("extract-timeout")), 12000)
            ),
        ]);
        
        if (result?.success && result.data) {
            const data = result.data as any;
            // Handle different response structures
            let candidate: any = null;
            if (Array.isArray(data)) {
                candidate = data[0] || data.find((d: any) => d?.extracted || d?.productName) || null;
            } else {
                candidate = data;
            }
            
            // Try multiple nesting patterns
            const extracted = candidate?.extracted ?? candidate?.extraction ?? candidate?.result ?? candidate?.data ?? candidate;
            
            // Extract fields with multiple fallbacks
            const productName = extracted?.productName ?? extracted?.name ?? extracted?.title ?? 
                                candidate?.productName ?? candidate?.name ?? candidate?.title ?? null;
            
            const imageUrl = extracted?.imageUrl ?? extracted?.image ?? 
                           (Array.isArray(extracted?.images) ? extracted.images.find((u: unknown) => typeof u === "string" && u) : null) ??
                           (Array.isArray(candidate?.images) ? candidate.images[0] : null) ?? null;
            
            const price = extracted?.price ?? extracted?.priceAmount ?? extracted?.amount ?? extracted?.pricing ?? 
                         candidate?.price ?? candidate?.priceAmount ?? null;
            
            // Return info even if only partial data exists
            if (productName || imageUrl || price) {
                const info = {
                    productName: productName || null,
                    displayName: productName ? makeDisplayName(productName) : null,
                    price: price ?? null,
                    imageUrl: imageUrl || null,
                };
                
                // Cache in-memory and Convex (non-blocking)
                productInfoCache.set(url, info);
                if (convexClient && (productName || imageUrl || price)) {
                    convexClient.mutation(api.products.upsert, {
                        url,
                        productName: productName || undefined,
                        price: price ?? undefined,
                        imageUrl: imageUrl || undefined,
                        raw: data,
                    }).catch(() => {}); // Fire and forget
                }
                
                return info;
            }
        }
    } catch (err) {
        // Log error for debugging but continue
        console.error(`Failed to extract product info for ${url}:`, err);
    }
    
    // HTML fallback: try to get at least image, name, and price from og tags and HTML
    let fallbackPrice: string | null = null;
    
    // First, try to extract price from snippet if available
    if (snippet) {
        fallbackPrice = extractPriceFromText(snippet);
    }
    
    try {
        const html = await fetchHtml(url);
        if (html) {
            // Use enhanced image extraction
            const imageUrl = extractImageFromHtml(html);
            const productName = extractOgTag(html, "og:title") || extractTitle(html);
            
            // Try to extract price from HTML if not found in snippet
            if (!fallbackPrice) {
                fallbackPrice = extractPriceFromHtml(html);
            }
            
            if (imageUrl || productName || fallbackPrice) {
                const info = {
                    productName: productName || null,
                    displayName: productName ? makeDisplayName(productName) : null,
                    price: fallbackPrice || null,
                    imageUrl: imageUrl || null,
                };
                productInfoCache.set(url, info);
                return info;
            }
        }
    } catch {}
    
    // If we got a price from snippet but nothing else, return it
    if (fallbackPrice) {
        const info = {
            productName: null,
            displayName: null,
            price: fallbackPrice,
            imageUrl: null,
        };
        productInfoCache.set(url, info);
        return info;
    }
    
    // Don't cache empty results - try again next time
    return {};
}

export async function POST(req: NextRequest) {
	try {
		const { query, numResults, extractProductInfo } = (await req.json()) as {
			query?: string;
			numResults?: number;
			extractProductInfo?: boolean;
		};
		if (!query || typeof query !== "string") {
			return NextResponse.json(
				{ error: "Missing or invalid 'query' in request body" },
				{ status: 400 }
			);
		}

		const q = query.trim().replace(/\s+/g, " ");
		if (q.length < 2) {
			return NextResponse.json(
				{ error: "Query too short" },
				{ status: 400 }
			);
		}
		if (q.length > 120) {
			return NextResponse.json(
				{ error: "Query too long" },
				{ status: 400 }
			);
		}
		if (!/[a-z0-9]/i.test(q)) {
			return NextResponse.json(
				{ error: "Query must contain alphanumeric characters" },
				{ status: 400 }
			);
		}
		
		// Validate query is specific enough
		const validation = validateSpecificQuery(q);
		if (!validation.valid) {
			return NextResponse.json(
				{ error: validation.error },
				{ status: 400 }
			);
		}

		const apiKey = process.env.FIRECRAWL_API_KEY;
		if (!apiKey) {
			console.error("FIRECRAWL_API_KEY is missing. Available env vars:", Object.keys(process.env).filter(k => k.includes('FIRECRAWL')));
			return NextResponse.json(
				{ error: "Server missing FIRECRAWL_API_KEY env var" },
				{ status: 500 }
			);
		}

		const desired = 4;
		const fetchLimit = 12; // fetch more to filter down to 1-4 strong commerce links

		// Try SDK first with a timeout
		let sdkData: any[] | null = null;
		try {
			const { default: Firecrawl } = await import("@mendable/firecrawl-js");
			const app = new Firecrawl({ apiKey });
			const sdkPromise = app.search(q, { limit: fetchLimit });
			const result = await Promise.race([
				sdkPromise,
				new Promise((_, reject) => setTimeout(() => reject(new Error("search-timeout")), 8000)),
			]);
			const search = result as any;
			if (search?.success && Array.isArray(search.data)) {
				sdkData = search.data;
			}
		} catch {}

		// Fallback to REST if SDK failed or timed out
		let dataArray: any[] = sdkData ?? [];
		if (!sdkData) {
			try {
				const res = await fetch("https://api.firecrawl.dev/v1/search", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${apiKey}`,
					},
					body: JSON.stringify({ query: q, limit: fetchLimit }),
				});
				if (res.ok) {
					const json = (await res.json()) as any;
					if (json?.success && Array.isArray(json.data)) {
						dataArray = json.data;
					} else if (Array.isArray(json)) {
						dataArray = json;
					}
				} else {
					const text = await res.text();
					return NextResponse.json({ error: `Firecrawl search error ${res.status}: ${text}` }, { status: 502 });
				}
			} catch (e) {
				return NextResponse.json({ error: "Firecrawl search failed" }, { status: 502 });
			}
		}

    // Normalize, filter, dedupe, and prioritize in one pass for speed
    const seen = new Set<string>();
    const normalized: Array<SearchResult & { isProductPage: boolean }> = [];
    
    for (const it of dataArray || []) {
        if (typeof it?.url !== "string") continue;
        const url = it.url;
        const key = url.split('#')[0];
        
        // Dedupe immediately
        if (seen.has(key)) continue;
        
        // Filter commerce URLs
        if (!isCommerceUrl(url)) continue;
        
        seen.add(key);
        const isProductPage = isProductDetailPage(url);
        normalized.push({
            title: it.title ?? null,
            url,
            snippet: it.snippet ?? it.description ?? null,
            isProductPage,
        });
        
        // Early exit if we have enough (get more candidates if extraction enabled)
        if (normalized.length >= (extractProductInfo !== false ? desired * 3 : desired * 2)) break;
    }
    
    // Sort: product pages first, then by priority hosts
    // If extraction enabled, filter out non-product pages first
    let filtered = normalized;
    if (extractProductInfo !== false) {
        // Prefer product detail pages when extraction is enabled
        filtered = normalized.filter(item => item.isProductPage);
        // If we don't have enough product pages, include all
        if (filtered.length < desired) {
            filtered = normalized;
        }
    }
    
    const deduped = filtered
        .sort((a, b) => {
            // Prioritize product detail pages
            if (a.isProductPage !== b.isProductPage) return a.isProductPage ? -1 : 1;
            return 0;
        })
        .slice(0, extractProductInfo !== false ? desired * 2 : desired) // Get more candidates if extracting
        .map(({ isProductPage, ...rest }) => rest);

    // If we still have < desired, relax by also including links whose snippet suggests shopping intent
    let pool = deduped;
    if (pool.length < desired) {
        const relax: SearchResult[] = (dataArray || [])
            .filter((it: any) => typeof it?.url === "string")
            .map((it: any) => ({ title: it.title ?? null, url: it.url, snippet: it.snippet ?? it.description ?? null }))
            .filter((it) => {
                if (!it.snippet) return false;
                const s = it.snippet.toLowerCase();
                return /buy|price|add to cart|in stock|purchase/.test(s);
            });
        for (const r of relax) {
            const key = r.url.split('#')[0];
            if (!pool.find((p) => p.url.split('#')[0] === key)) pool.push(r);
            if (pool.length >= desired) break;
        }
    }

    const prioritized = prioritizeCommerce(pool);
    const items = prioritized.slice(0, desired);

    // Always return links immediately - let frontend handle extraction if needed
    // This provides instant feedback while product info loads in the background
    return NextResponse.json({ results: items }, { status: 200 });
	} catch (err) {
		return NextResponse.json(
			{ error: err instanceof Error ? err.message : "Unknown server error" },
			{ status: 500 }
		);
	}
}


