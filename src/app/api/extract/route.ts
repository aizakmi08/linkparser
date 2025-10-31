import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../../convex/_generated/api";

export const runtime = "nodejs";

// Simple in-memory cache to speed up repeated requests
const CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour
const cache = new Map<string, { at: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

type ExtractResponse = {
	productName?: string | null;
    shortName?: string | null;
	displayName?: string | null;
	price?: number | string | null; // original value from Firecrawl or parsed
	imageUrl?: string | null; // single primary image
	raw?: unknown; // raw payload from Firecrawl for debugging
};

type ParsedPrice = {
	amount: number;
	currency: string; // ISO code when possible (e.g., USD, EUR)
};

const SYMBOL_TO_CURRENCY: Record<string, string> = {
	"$": "USD",
	"€": "EUR",
	"£": "GBP",
	"¥": "JPY",
	"₹": "INR",
	"₩": "KRW",
	"₽": "RUB",
	"C$": "CAD",
	"A$": "AUD",
};

function parsePrice(input: unknown): ParsedPrice | null {
	if (typeof input === "number" && isFinite(input)) {
		return { amount: input, currency: "USD" };
	}
	if (typeof input !== "string") return null;

	const trimmed = input.trim();
	// Try to find an explicit currency code first (e.g., USD, EUR)
	const codeMatch = trimmed.match(/\b(USD|EUR|GBP|JPY|INR|CAD|AUD|CHF|CNY|KRW|RUB)\b/i);
	const currencyFromCode = codeMatch?.[1]?.toUpperCase();

	// Handle currency symbols and formatted numbers with commas
	// Examples: "$1,299.00", "EUR 59,90", "£79.99", "1.299,00 €"
	const symbolMatch = trimmed.match(/(C\$|A\$|[€£¥₹₩₽$])/);
	const symbol = symbolMatch?.[1];

	// Extract number: allow both 1,234.56 and 1.234,56 styles
	// Normalize to dot decimal
	let numericPart = trimmed
		.replace(/[^0-9.,]/g, "")
		.replace(/(\d)[.,](?=\d{3}(\D|$))/g, "$1,") // mark thousands as comma
		.replace(/\.(?=\d{3}(\D|$))/g, ",") // ensure thousands use comma
		.replace(/,(?=\d{3}(\D|$))/g, ",");

	// If there are both comma and dot, assume comma is thousands and dot is decimal
	// If only comma present and it's used as decimal (e.g., 59,90), convert to dot
	const hasDot = numericPart.includes(".");
	const hasComma = numericPart.includes(",");
	if (hasComma && !hasDot) {
		// Likely decimal comma locale
		numericPart = numericPart.replace(/\./g, "");
		numericPart = numericPart.replace(/,/g, ".");
	} else {
		// Remove thousands commas
		numericPart = numericPart.replace(/,/g, "");
	}

	const amount = Number(numericPart);
	if (!isFinite(amount)) return null;

	const currency = currencyFromCode || (symbol ? SYMBOL_TO_CURRENCY[symbol] : undefined) || "USD";
	return { amount, currency };
}

// Normalize Firecrawl response into our ExtractResponse shape
async function normalizeResponse(value: any): Promise<ExtractResponse> {
	const candidate = value?.data ?? value;
	const first = Array.isArray(candidate) ? candidate[0] : candidate;

	// Firecrawl v1 extract typically nests under `extracted` or `extraction`
	const extracted = first?.extracted ?? first?.extraction ?? first?.result ?? first;
    const productName = extracted?.productName ?? extracted?.name ?? extracted?.title ?? null;

	// Choose a single main image deterministically
	const imageUrl = (
		extracted?.imageUrl ||
		extracted?.image ||
		(Array.isArray(extracted?.images) ? extracted.images.find((u: unknown) => typeof u === "string" && u) : null)
	) ?? null;

	// Resolve price
	const rawPrice: unknown = extracted?.price ?? extracted?.priceAmount ?? extracted?.amount ?? extracted?.pricing ?? null;

	return {
		productName,
        shortName: extracted?.shortName ?? null,
		displayName: productName ? makeDisplayName(productName) : extracted?.shortName ?? null,
		price: rawPrice ?? null,
		imageUrl,
		raw: value,
	};
}

async function fetchHtml(url: string): Promise<string | null> {
    try {
        const res = await fetch(url, {
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
                "Accept-Language": "en-US,en;q=0.9",
            },
        });
        if (!res.ok) return null;
        const html = await res.text();
        return html;
    } catch {
        return null;
    }
}

function simplifyName(name: string): string {
    const lower = name.toLowerCase();
    // Split on separators and take the earliest meaningful chunk
    const primary = lower.split(/\s+-\s+|:\s+|\|/)[0];
    const tokens = primary
        .replace(/\(.*?\)|\[.*?\]/g, " ")
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(Boolean);
    const stop = new Set([
        "with","and","for","the","a","an","of","by","at","to","from","in","on","&","amp",
        "double","stainless","steel","insulation","dishwasher","safe","bpa","free","removable","bumper",
        "inch","inches","oz","ounce","ounces","ml","liter","litre","pack","set","new",
        "black","white","blue","red","green","yellow","pink","purple","blush","silver","gold","grey","gray",
    ]);
    const important = tokens.filter((t) => !stop.has(t) && !/^\d+$/.test(t));
    // Prefer last 2-3 informative tokens to capture the category (e.g., "water bottle")
    const out = important.slice(-3).join(" ").trim();
    return out || tokens.slice(0, 3).join(" ");
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

function hasMonthlyContext(source: string, startIdx: number, endIdx: number): boolean {
	const before = source.slice(Math.max(0, startIdx - 24), startIdx).toLowerCase();
	const after = source.slice(endIdx, Math.min(source.length, endIdx + 24)).toLowerCase();
	const windowText = before + " " + after;
	return /(per\s*month|\/\s*mo\b|\/\s*month\b|monthly\b|mo\.)/i.test(windowText);
}

function extractPriceFromVisibleText(text: string): string | null {
	// Look for $123.45 or $123 etc., skipping monthly contexts
	const patterns = [/\$[\d,]+\.\d{2}\b/g, /\$\d{2,}[\d,]*\b/g];
	for (const p of patterns) {
		let m: RegExpExecArray | null;
		while ((m = p.exec(text)) !== null) {
			const start = m.index;
			const end = m.index + m[0].length;
			if (hasMonthlyContext(text, start, end)) continue; // skip financing
			return m[0];
		}
	}
	return null;
}

function extractPriceFromHtml(html: string): string | null {
	// Try JSON-LD structured data first (often correct one-time prices)
	const jsonLdMatches = Array.from(html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi));
	for (const match of jsonLdMatches) {
		try {
			const jsonLd = JSON.parse(match[1]);
			const items = Array.isArray(jsonLd) ? jsonLd : [jsonLd];
			for (const item of items) {
				if (item?.offers?.price != null) {
					const price = item.offers.price;
					if (typeof price === "number") return `$${price.toFixed(2)}`;
					if (typeof price === "string") {
						const num = parseFloat(price);
						if (!isNaN(num)) return `$${num.toFixed(2)}`;
					}
				}
				if (item?.price != null) {
					const price = item.price;
					if (typeof price === "number") return `$${price.toFixed(2)}`;
					if (typeof price === "string") {
						const num = parseFloat(price);
						if (!isNaN(num)) return `$${num.toFixed(2)}`;
					}
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
	
	// Try common price selectors, skipping monthly/financing contexts
	const selectorPatterns = [
		/id=["']price[^"']*["'][^>]*>\s*\$?\s*([\d,]+\.?\d*)/gi,
		/class=["'][^"']*price[^"']*["'][^>]*>\s*\$?\s*([\d,]+\.?\d*)/gi,
		/data-price=["']([^"']+)["']/gi,
		/price["']?\s*:\s*["']?\$?([\d,]+\.?\d*)/gi,
	];
	for (const re of selectorPatterns) {
		let m: RegExpExecArray | null;
		while ((m = re.exec(html)) !== null) {
			const raw = m[1];
			const num = parseFloat(String(raw).replace(/,/g, ""));
			if (isNaN(num) || num <= 0) continue;
			const start = m.index;
			const end = m.index + m[0].length;
			if (hasMonthlyContext(html, start, end)) continue; // skip "$27/mo"
			return `$${num.toFixed(2)}`;
		}
	}
	
	// Last resort: extract from visible text (skip monthly contexts)
	const textContent = html
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
	const fromText = extractPriceFromVisibleText(textContent);
	if (fromText) return fromText;
	
	// Fallback to Amazon-specific logic
	return extractAmazonPrice(html);
}

function extractTitle(html: string): string | null {
    const m = html.match(/<title>([^<]+)<\/title>/i);
    if (m?.[1]) {
        return m[1].replace(/\s+/g, " ").trim();
    }
    return null;
}

function extractAmazonPrice(html: string): string | null {
    // Try embedded buybox JSON first
    const buyboxMatch = html.match(/desktop_buybox_group_1"\s*:\s*\[(\{[\s\S]*?\})\]/);
    if (buyboxMatch) {
        try {
            const obj = JSON.parse(buyboxMatch[1]);
            if (obj?.displayPrice) return String(obj.displayPrice);
            if (typeof obj?.priceAmount === "number" && isFinite(obj.priceAmount)) {
                const symbol = typeof obj?.currencySymbol === "string" ? obj.currencySymbol : "$";
                return `${symbol}${obj.priceAmount}`;
            }
        } catch {}
    }
    // Fallback to common price spans
    const priceMatch = html.match(/id=\"priceblock[^"]*\"[^>]*>\s*\$?([0-9.,]+)/i);
    if (priceMatch) {
        const amount = priceMatch[1];
        return amount.startsWith("$") ? amount : `$${amount}`;
    }
    // Try "priceToPay"
    const priceToPay = html.match(/priceToPay[\s\S]*?\$\s*([0-9.,]+)/i);
    if (priceToPay) return `$${priceToPay[1]}`;
    return null;
}

export async function POST(req: NextRequest) {
	try {
        const { url } = (await req.json()) as { url?: string };
        if (!url || typeof url !== "string") {
			return NextResponse.json(
				{ error: "Missing or invalid 'url' in request body" },
				{ status: 400 }
			);
		}
        if (url.length > 2048) {
            return NextResponse.json(
                { error: "URL too long" },
                { status: 400 }
            );
        }
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            return NextResponse.json(
                { error: "Invalid URL format" },
                { status: 400 }
            );
        }
        if (!/^https?:$/.test(parsed.protocol)) {
            return NextResponse.json(
                { error: "Only http/https URLs are allowed" },
                { status: 400 }
            );
        }
        if (!parsed.hostname || parsed.hostname.split(".").length < 2) {
            return NextResponse.json(
                { error: "URL must include a valid hostname" },
                { status: 400 }
            );
        }

        // Guard against login-walled domains (e.g., Facebook Marketplace)
        try {
            const { hostname } = parsed;
            const blockedHosts = [
                "www.facebook.com",
                "facebook.com",
                "m.facebook.com",
            ];
            if (blockedHosts.includes(hostname)) {
                return NextResponse.json(
                    {
                        error:
                            "This URL requires authentication (e.g., Facebook Marketplace). Please provide a public product page.",
                    },
                    { status: 422 }
                );
            }
        } catch {}

		const apiKey = process.env.FIRECRAWL_API_KEY;
		if (!apiKey) {
			return NextResponse.json(
				{ error: "Server missing FIRECRAWL_API_KEY env var" },
				{ status: 500 }
			);
		}

		// Use Firecrawl SDK (matches playground behavior)
		const { default: Firecrawl } = await import("@mendable/firecrawl-js");
		const firecrawl = new Firecrawl({ apiKey });

		const schema = z.object({
			productName: z.string().describe("Product name/title"),
			price: z.union([z.string(), z.number()]).describe("Price as string or number"),
			imageUrl: z.string().optional().describe("Primary image"),
		});

		// Check Convex persistent cache first (if configured)
		const convexUrl = process.env.CONVEX_URL;
		let convexClient: ConvexHttpClient | null = null;
		if (convexUrl) {
			convexClient = new ConvexHttpClient(convexUrl);
			try {
                const existing = await convexClient.query(api.products.getByUrl, { url });
				if (existing) {
					return NextResponse.json(await normalizeResponse(existing), { status: 200 });
				}
			} catch {}
		}

		// In-memory cache as secondary fast path
		const now = Date.now();
		const cached = cache.get(url);
		if (cached && now - cached.at < CACHE_TTL_MS) {
			return NextResponse.json(await normalizeResponse(cached.value), { status: 200 });
		}

		// Deduplicate concurrent requests for the same URL
        let p = inflight.get(url);
		if (!p) {
			p = firecrawl.extract({
				urls: [url],
                prompt:
                    "Extract productName (title), price (formatted), imageUrl (main).\n- For Amazon, prefer Buy Box/current variant price (priceToPay/displayPrice). Avoid list/crossed-out/sponsored prices. Use hero image or og:image.",
				schema,
			});
			inflight.set(url, p);
		}
		// Add timeout to prevent hanging
		let extractResult: any;
		try {
			extractResult = await Promise.race([
				p.finally(() => inflight.delete(url)),
				new Promise<any>((_, reject) => setTimeout(() => reject(new Error("extract-timeout")), 20000)),
			]);
		} catch (timeoutErr) {
			if (timeoutErr instanceof Error && timeoutErr.message === "extract-timeout") {
				// As a fallback, try to extract minimal info from HTML and return 200 with partial data
				const html = await fetchHtml(url);
				if (html) {
					const imageUrl = extractImageFromHtml(html);
					const productName = extractOgTag(html, "og:title") || extractTitle(html);
					const price = extractPriceFromHtml(html);
					const partial = {
						productName: productName || null,
						shortName: productName ? simplifyName(productName) : null,
						displayName: productName ? makeDisplayName(productName) : null,
						price: price || null,
						imageUrl: imageUrl || null,
						raw: null,
					};
					return NextResponse.json(partial, { status: 200 });
				}
				return NextResponse.json(
					{ error: "Extraction timed out after 20 seconds." },
					{ status: 504 }
				);
			}
			throw timeoutErr; // Re-throw if it's a different error
		}
		
		if (!extractResult.success) {
			return NextResponse.json(
				{ error: extractResult.error || "Firecrawl extract failed" },
				{ status: 502 }
			);
		}
        let data = extractResult.data as unknown;
		cache.set(url, { at: Date.now(), value: data });
        let result = await normalizeResponse(data);
        if ((!result.shortName || result.shortName.length > 24) && result.productName) {
            result.shortName = simplifyName(result.productName);
        }
        if (!result.displayName && result.productName) {
            result.displayName = makeDisplayName(result.productName);
        }

        // If critical fields missing, try lightweight HTML fallback parse
        if (!result.price || !result.imageUrl || !result.productName) {
            const html = await fetchHtml(url);
            if (html) {
                if (!result.imageUrl) {
                    // Use enhanced image extraction
                    result.imageUrl = extractImageFromHtml(html);
                }
                if (!result.productName) {
                    const t = extractOgTag(html, "og:title") || extractTitle(html);
                    if (t) result.productName = t;
                }
                if ((!result.shortName || result.shortName.length > 24) && result.productName) {
                    result.shortName = simplifyName(result.productName);
                }
                if (!result.displayName && result.productName) {
                    result.displayName = makeDisplayName(result.productName);
                }
                if (!result.price) {
                    // Use enhanced price extraction
                    const ptxt = extractPriceFromHtml(html);
                    if (ptxt) result.price = ptxt;
                }
            }
        }

		// Write-through to Convex (non-blocking for faster response)
		if (convexClient) {
			convexClient.mutation(api.products.upsert, {
				url,
				productName: result.productName || undefined,
				price: result.price ?? undefined,
				imageUrl: result.imageUrl || undefined,
				raw: result.raw,
			}).catch(() => {}); // Fire and forget
		}

		return NextResponse.json(result, { status: 200 });
	} catch (err) {
		return NextResponse.json(
			{ error: err instanceof Error ? err.message : "Unknown server error" },
			{ status: 500 }
		);
	}
}


