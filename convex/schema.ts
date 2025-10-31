import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
	products: defineTable({
		url: v.string(),
		productName: v.optional(v.string()),
		price: v.optional(v.union(v.string(), v.number())),
		imageUrl: v.optional(v.string()),
		raw: v.optional(v.any()),
		updatedAt: v.number(),
	}).index("by_url", ["url"]),
});


