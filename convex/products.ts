import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getByUrl = query({
	args: { url: v.string() },
	handler: async (ctx, { url }) => {
		const doc = await ctx.db
			.query("products")
			.withIndex("by_url", (q) => q.eq("url", url))
			.first();
		return doc ?? null;
	},
});

export const upsert = mutation({
	args: {
		url: v.string(),
		productName: v.optional(v.string()),
		price: v.optional(v.union(v.string(), v.number())),
		imageUrl: v.optional(v.string()),
		raw: v.optional(v.any()),
	},
	handler: async (ctx, { url, productName, price, imageUrl, raw }) => {
		const now = Date.now();
		const existing = await ctx.db
			.query("products")
			.withIndex("by_url", (q) => q.eq("url", url))
			.first();
		if (existing) {
			await ctx.db.patch(existing._id, {
				productName,
				price,
				imageUrl,
				raw,
				updatedAt: now,
			});
			return existing._id;
		}
		return await ctx.db.insert("products", {
			url,
			productName,
			price,
			imageUrl,
			raw,
			updatedAt: now,
		});
	},
});


