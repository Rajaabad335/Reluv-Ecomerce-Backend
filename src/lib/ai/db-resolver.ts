import type { Core } from "@strapi/strapi";
import type { ResolvedField, ResolvedTextField } from "./types";
import type { ValidatedGeminiSuggestion } from "./schemas";

const AUTO_CONFIDENCE_THRESHOLD = 95;
const SUGGESTED_CONFIDENCE_THRESHOLD = 80;
const STYLE_ATTRIBUTE_CODES = ["fit", "occasion", "pattern"];

function tierFromConfidence(confidence: number): "auto" | "suggested" | "unknown" {
  if (confidence >= AUTO_CONFIDENCE_THRESHOLD) return "auto";
  if (confidence >= SUGGESTED_CONFIDENCE_THRESHOLD) return "suggested";
  return "unknown";
}

function unresolvedField(rawValue: string | null, confidence: number): ResolvedField {
  return { rawValue, confidence, tier: tierFromConfidence(confidence), resolvedId: null, resolvedLabel: null, attributeCode: null };
}

function normalizeForMatch(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

interface LookupRow {
  id: number;
  name?: string | null;
  slug?: string | null;
  value?: string | null;
}

async function findBestMatch(rows: LookupRow[], rawValue: string): Promise<LookupRow | null> {
  const target = normalizeForMatch(rawValue);
  if (!target) return null;

  for (const row of rows) {
    const label = row.name ?? row.value ?? "";
    if (label && normalizeForMatch(label) === target) return row;
  }
  for (const row of rows) {
    if (row.slug && normalizeForMatch(row.slug) === target) return row;
  }
  for (const row of rows) {
    const label = normalizeForMatch(row.name ?? row.value ?? "");
    if (label && (label.includes(target) || target.includes(label))) return row;
  }
  return null;
}

export class DbResolver {
  private readonly strapi: Core.Strapi;

  constructor(deps: { strapi: Core.Strapi }) {
    this.strapi = deps.strapi;
  }

  async resolveBrand(rawField: { value: string | null; confidence: number }, categoryId: number | null): Promise<ResolvedField> {
    if (!rawField.value) return unresolvedField(null, rawField.confidence);
    const rows = (await this.strapi.entityService.findMany("api::brand.brand", {
      filters: categoryId ? { categories: { id: { $eq: categoryId } } } : {},
      fields: ["id", "name", "slug"],
      limit: 500,
    })) as unknown as LookupRow[];
    return this.toResolvedField(rawField, await findBestMatch(rows, rawField.value));
  }

  async resolveMaterial(rawField: { value: string | null; confidence: number }, categoryId: number | null): Promise<ResolvedField> {
    if (!rawField.value) return unresolvedField(null, rawField.confidence);
    const rows = (await this.strapi.entityService.findMany("api::material.material", {
      filters: categoryId ? { categories: { id: { $eq: categoryId } } } : {},
      fields: ["id", "name", "slug"],
      limit: 500,
    })) as unknown as LookupRow[];
    return this.toResolvedField(rawField, await findBestMatch(rows, rawField.value));
  }

  async resolveColor(rawField: { value: string | null; confidence: number }, categoryId: number | null): Promise<ResolvedField> {
    if (!rawField.value) return unresolvedField(null, rawField.confidence);
    const rows = (await this.strapi.entityService.findMany("api::color.color", {
      filters: categoryId ? { categories: { id: { $eq: categoryId } } } : {},
      fields: ["id", "name", "slug"],
      limit: 500,
    })) as unknown as LookupRow[];
    return this.toResolvedField(rawField, await findBestMatch(rows, rawField.value));
  }

  async resolveCondition(rawField: { value: string | null; confidence: number }, categoryId: number | null): Promise<ResolvedField> {
    if (!rawField.value) return unresolvedField(null, rawField.confidence);
    const rows = (await this.strapi.entityService.findMany("api::condition.condition", {
      filters: categoryId ? { categories: { id: { $eq: categoryId } } } : {},
      fields: ["id", "name", "slug"],
      limit: 100,
    })) as unknown as LookupRow[];
    return this.toResolvedField(rawField, await findBestMatch(rows, rawField.value));
  }

  async resolveCategory(
    categoryField: { value: string | null; confidence: number },
    subcategoryField: { value: string | null; confidence: number },
  ): Promise<{ category: ResolvedField; subcategory: ResolvedField }> {
    if (!categoryField.value && !subcategoryField.value) {
      return {
        category: unresolvedField(categoryField.value, categoryField.confidence),
        subcategory: unresolvedField(subcategoryField.value, subcategoryField.confidence),
      };
    }

    const allCategories = (await this.strapi.entityService.findMany("api::category.category", {
      fields: ["id", "name", "slug"],
      populate: { category: { fields: ["id", "name"] } },
      limit: 5000,
    })) as unknown as Array<LookupRow & { category?: { id: number; name?: string } | null }>;

    let categoryMatch: LookupRow | null = null;
    let subcategoryMatch: LookupRow | null = null;

    if (subcategoryField.value) {
      subcategoryMatch = await findBestMatch(allCategories, subcategoryField.value);
      if (subcategoryMatch) {
        const parent = allCategories.find((c) => c.id === (subcategoryMatch as any).category?.id);
        if (parent) categoryMatch = parent;
      }
    }

    if (!categoryMatch && categoryField.value) {
      categoryMatch = await findBestMatch(allCategories, categoryField.value);
    }

    return {
      category: this.toResolvedField(categoryField, categoryMatch),
      subcategory: this.toResolvedField(subcategoryField, subcategoryMatch),
    };
  }

  async resolveGenderBranch(rawField: { value: string | null; confidence: number }): Promise<ResolvedField> {
    if (!rawField.value) return unresolvedField(null, rawField.confidence);
    const rootCategories = (await this.strapi.entityService.findMany("api::category.category", {
      filters: { category: { id: { $null: true } } },
      fields: ["id", "name", "slug"],
      limit: 50,
    })) as unknown as LookupRow[];
    return this.toResolvedField(rawField, await findBestMatch(rootCategories, rawField.value));
  }

  async resolveStyle(rawField: { value: string | null; confidence: number }, categoryId: number | null): Promise<ResolvedField> {
    if (!rawField.value) return unresolvedField(null, rawField.confidence);

    const attributeFilters = categoryId
      ? { categories: { id: { $eq: categoryId } }, code: { $in: STYLE_ATTRIBUTE_CODES } }
      : { code: { $in: STYLE_ATTRIBUTE_CODES } };

    const attributes = (await this.strapi.entityService.findMany("api::category-attribute.category-attribute", {
      filters: attributeFilters,
      fields: ["id", "code"],
      populate: { category_attribute_options: { fields: ["id", "value"] } },
      limit: 50,
    })) as unknown as Array<{ id: number; code: string; category_attribute_options?: Array<{ id: number; value: string }> }>;

    for (const attribute of attributes) {
      const options = (attribute.category_attribute_options ?? []).map((o) => ({ id: o.id, value: o.value })) as LookupRow[];
      const match = await findBestMatch(options, rawField.value);
      if (match) {
        const resolved = this.toResolvedField(rawField, match);
        resolved.attributeCode = attribute.code;
        return resolved;
      }
    }

    return unresolvedField(rawField.value, rawField.confidence);
  }

  resolveText(rawField: { value: string | null; confidence: number }): ResolvedTextField {
    return { rawValue: rawField.value, confidence: rawField.confidence, tier: tierFromConfidence(rawField.confidence), text: rawField.value };
  }

  private toResolvedField(rawField: { value: string | null; confidence: number }, match: LookupRow | null): ResolvedField {
    if (!match) return unresolvedField(rawField.value, rawField.confidence);
    return {
      rawValue: rawField.value,
      confidence: rawField.confidence,
      tier: tierFromConfidence(rawField.confidence),
      resolvedId: match.id,
      resolvedLabel: match.name ?? match.value ?? null,
      attributeCode: null,
    };
  }
}

export async function resolveAllFields(strapi: Core.Strapi, suggestion: ValidatedGeminiSuggestion, categoryId: number | null) {
  const resolver = new DbResolver({ strapi });
  const safe = (f: any) => ({ value: f?.value ?? null, confidence: Number(f?.confidence ?? 0) });

  const [brand, material, primaryColor, secondaryColor, condition, categoryPair, gender, style] = await Promise.all([
    resolver.resolveBrand(safe(suggestion.brand), categoryId),
    resolver.resolveMaterial(safe(suggestion.material), categoryId),
    resolver.resolveColor(safe(suggestion.primaryColor), categoryId),
    resolver.resolveColor(safe(suggestion.secondaryColor), categoryId),
    resolver.resolveCondition(safe(suggestion.condition), categoryId),
    resolver.resolveCategory(safe(suggestion.category), safe(suggestion.subcategory)),
    resolver.resolveGenderBranch(safe(suggestion.gender)),
    resolver.resolveStyle(safe(suggestion.style), categoryId),
  ]);

  return {
    brand,
    material,
    primaryColor,
    secondaryColor,
    condition,
    category: categoryPair.category,
    subcategory: categoryPair.subcategory,
    gender,
    style,
    title: resolver.resolveText(safe(suggestion.title)),
    description: resolver.resolveText(safe(suggestion.description)),
  };
}
