import type { Core } from "@strapi/strapi";
import { getGeminiClient, type ImageInput } from "./gemini-client";
import { parseGeminiResponse } from "./schemas";
import { resolveAllFields } from "./db-resolver";
import { LuxuryService } from "./luxury-service";
import type { PromptContext } from "./prompt";
import type { AnalyzeListingResult, ResolvedSuggestions, SuggestedPrice } from "./types";

export type OrchestratorResult =
  | { ok: true; result: AnalyzeListingResult }
  | { ok: false; httpStatus: number; message: string };

interface MediaFileRow {
  id: number;
  url: string;
  mime: string;
}

export class ListingAiOrchestrator {
  private readonly strapi: Core.Strapi;

  constructor(deps: { strapi: Core.Strapi }) {
    this.strapi = deps.strapi;
  }

  async analyze(params: {
    userId: number;
    imageIds: number[];
    categoryId: number | null;
    requestIp: string | null;
  }): Promise<OrchestratorResult> {
    const startedAt = Date.now();
    const strapiEnv = (key: string, fallback?: string) => process.env[key] ?? fallback;
    let modelVersionForLog = "unknown";

    try {
      const mediaRows = (await this.strapi.entityService.findMany("plugin::upload.file", {
        filters: { id: { $in: params.imageIds } },
        fields: ["id", "url", "mime"],
      })) as unknown as MediaFileRow[];

      if (mediaRows.length !== params.imageIds.length) {
        return { ok: false, httpStatus: 400, message: "One or more imageIds do not correspond to an uploaded image." };
      }

      const images = await this.loadImageBytes(mediaRows);
      const promptContext = await this.buildPromptContext(params.categoryId);
      const client = getGeminiClient(strapiEnv);
      const geminiResult = await client.analyzeListingImages(images, promptContext);

      if (!geminiResult.ok) {
        const g = geminiResult as { ok: false; reason: string; detail: string };
        await this.logFailure(params, `Gemini call failed (${g.reason}): ${g.detail}`, startedAt);
        const httpStatus = g.reason === "timeout" ? 504 : 502;
        return { ok: false, httpStatus, message: "The AI analysis service did not respond successfully. Please try again." };
      }

      modelVersionForLog = geminiResult.modelVersion;

      const parsed = parseGeminiResponse(geminiResult.rawText);
      if (!parsed.ok) {
        const p = parsed as { ok: false; error: string; rawText: string };
        await this.logFailure(params, p.error, startedAt, geminiResult.modelVersion);
        return { ok: false, httpStatus: 502, message: "The AI response could not be validated and was discarded." };
      }

      const resolvedFields = await resolveAllFields(this.strapi, (parsed as { ok: true; data: any }).data.suggestion, params.categoryId);
      const suggestions: ResolvedSuggestions = resolvedFields;

      const luxuryService = new LuxuryService({ strapi: this.strapi });
      const luxury = await luxuryService.assess(suggestions.brand, parsed.data.luxurySignal);

      const suggestedPrice = await this.buildPriceSuggestion(params.categoryId, suggestions);

      const requestId = await this.logSuccess(params, (parsed as { ok: true; data: any }).data, geminiResult.modelVersion, startedAt);

      return { ok: true, result: { requestId, suggestions, suggestedPrice, luxury, modelVersion: geminiResult.modelVersion } };
    } catch (error) {
      await this.logFailure(params, `Unexpected orchestrator error: ${(error as Error).message}`, startedAt, modelVersionForLog);
      return { ok: false, httpStatus: 500, message: "Something went wrong while analyzing these images." };
    }
  }

  async rescope(params: { requestId: string; categoryId: number }): Promise<OrchestratorResult> {
    try {
      const logRow = await this.strapi.entityService.findOne(
        "api::ai-request-log.ai-request-log" as any,
        Number(params.requestId),
        { fields: ["id", "status", "rawValidatedResponse", "modelVersion"] },
      );

      if (!logRow || (logRow as { status?: string }).status !== "success") {
        return { ok: false, httpStatus: 404, message: "No prior successful analysis found for this requestId." };
      }

      const rawValidatedResponse = (logRow as { rawValidatedResponse?: unknown }).rawValidatedResponse;
      const parsed = parseGeminiResponse(JSON.stringify(rawValidatedResponse));
      if (!parsed.ok) {
        return { ok: false, httpStatus: 500, message: "Stored analysis result is corrupted and cannot be reused." };
      }

      const suggestions = await resolveAllFields(this.strapi, parsed.data.suggestion, params.categoryId);
      const luxuryService = new LuxuryService({ strapi: this.strapi });
      const luxury = await luxuryService.assess(suggestions.brand, parsed.data.luxurySignal);

      const suggestedPrice = await this.buildPriceSuggestion(params.categoryId, suggestions);

      return {
        ok: true,
        result: {
          requestId: params.requestId,
          suggestions,
          suggestedPrice,
          luxury,
          modelVersion: (logRow as { modelVersion?: string }).modelVersion ?? "unknown",
        },
      };
    } catch (error) {
      return { ok: false, httpStatus: 500, message: `Failed to rescope suggestion: ${(error as Error).message}` };
    }
  }

  private async buildPriceSuggestion(
    categoryId: number | null,
    suggestions: ResolvedSuggestions,
  ): Promise<SuggestedPrice> {
    const DISCLAIMER = "Suggested price is for reference only and is not a valuation, professional appraisal, or guarantee of sale price.";
    try {
      const normalize = (value: unknown): string =>
        String(value ?? "")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();

      const tokenSet = (value: string): Set<string> =>
        new Set(
          normalize(value)
            .split(" ")
            .filter((token) => token.length > 2),
        );

      const overlapScore = (a: Set<string>, b: Set<string>): number => {
        if (a.size === 0 || b.size === 0) return 0;
        let matches = 0;
        for (const token of a) {
          if (b.has(token)) matches += 1;
        }
        return matches / Math.max(a.size, b.size);
      };

      const getName = (value: any): string => {
        if (!value) return "";
        if (typeof value === "string" || typeof value === "number") return String(value);
        return String(value.name ?? value.title ?? value.label ?? value.value ?? "");
      };

      const normalizeAttributeCode = (value: unknown): string =>
        String(value ?? "")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "");

      const getComparableAttributeValues = (row: Record<string, any>): Array<{ code: string; value: string }> => {
        const pavs = Array.isArray(row.product_attribute_values) ? row.product_attribute_values : [];
        return pavs
          .map((pav: any) => {
            const code = normalizeAttributeCode(pav?.category_attribute?.code ?? pav?.category_attribute?.name);
            const value =
              pav?.category_attribute_option?.value ??
              pav?.valueText ??
              pav?.valueNumber ??
              pav?.valueBoolean ??
              null;
            const text = String(value ?? "").trim();
            if (!code || !text) return null;
            return { code, value: text };
          })
          .filter((entry): entry is { code: string; value: string } => Boolean(entry));
      };

      const findComparableAttributeValue = (row: Record<string, any>, families: string[]): string => {
        const normalizedFamilies = families.map(normalizeAttributeCode);
        const attributes = getComparableAttributeValues(row);
        const match = attributes.find((attribute) =>
          normalizedFamilies.some(
            (family) =>
              attribute.code === family ||
              attribute.code.startsWith(`${family}_`) ||
              attribute.code.endsWith(`_${family}`),
          ),
        );
        return match?.value ?? "";
      };

      const filters: any = { productStatus: { $eq: "active" } };
      if (categoryId) filters.category = { id: { $eq: categoryId } };

      const rows = (await this.strapi.entityService.findMany("api::product.product" as any, {
        filters,
        fields: ["price", "title", "createdAt"],
        populate: {
          brand: { fields: ["id", "name"] },
          product_condition: { fields: ["id", "name"] },
          material: { fields: ["id", "name"] },
          color: { fields: ["id", "name"] },
          size: { fields: ["id", "name"] },
          product_attribute_values: {
            fields: ["id", "valueText", "valueNumber", "valueBoolean"],
            populate: {
              category_attribute: { fields: ["code", "name"] },
              category_attribute_option: { fields: ["value"] },
            },
          },
        },
        limit: 200,
        sort: { createdAt: "desc" },
      })) as unknown as Array<Record<string, any>>;

      const targetBrand = normalize(suggestions.brand.resolvedLabel || suggestions.brand.rawValue || "");
      const targetCondition = normalize(suggestions.condition.resolvedLabel || suggestions.condition.rawValue || "");
      const targetMaterial = normalize(suggestions.material.resolvedLabel || suggestions.material.rawValue || "");
      const targetColor = normalize(suggestions.Color.resolvedLabel || suggestions.Color.rawValue || "");
      const targetTitle = tokenSet(suggestions.title.text || "");

      const scoredRows = rows
        .map((row) => {
          const price = Number(row.price);
          if (!Number.isFinite(price) || price <= 0) return null;

          const brandName =
            normalize(getName(row.brand)) ||
            normalize(findComparableAttributeValue(row, ["brand", "brand_name"]));
          const conditionName =
            normalize(getName(row.product_condition)) ||
            normalize(findComparableAttributeValue(row, ["condition", "product_condition"]));
          const materialName =
            normalize(getName(row.material)) ||
            normalize(findComparableAttributeValue(row, ["material", "fabric"]));
          const colorName =
            normalize(getName(row.color)) ||
            normalize(findComparableAttributeValue(row, ["colour", "color"]));
          const title = normalize(row.title);
          const titleTokens = tokenSet(title);
          const ageMs = Date.now() - new Date(row.createdAt ?? Date.now()).getTime();
          const ageDays = Number.isFinite(ageMs) ? Math.max(0, ageMs / 86_400_000) : 0;
          const recencyWeight = 1 / (1 + ageDays / 120);

          let matchScore = 0;

          if (suggestions.brand.resolvedId && Number(row.brand?.id) === Number(suggestions.brand.resolvedId)) {
            matchScore += 3.5;
          } else if (targetBrand && brandName === targetBrand) {
            matchScore += 3;
          } else if (targetBrand && brandName.includes(targetBrand)) {
            matchScore += 2;
          }

          if (targetCondition && conditionName === targetCondition) matchScore += 2;
          if (targetMaterial && materialName === targetMaterial) matchScore += 1.5;
          if (targetColor && colorName === targetColor) matchScore += 1;
          const titleOverlap = overlapScore(targetTitle, titleTokens);
          if (titleOverlap >= 0.25) matchScore += Math.min(2, titleOverlap * 4);

          const weight = matchScore * recencyWeight;
          if (weight <= 0) return null;

          return { price, weight, matchScore };
        })
        .filter((row): row is { price: number; weight: number; matchScore: number } => Boolean(row))
        .filter((row) => row.matchScore >= 1.5)
        .sort((a, b) => b.weight - a.weight);

      const usableRows = scoredRows.slice(0, 20);
      if (usableRows.length < 3) {
        return {
          amount: null,
          lowAmount: null,
          highAmount: null,
          currency: "THB",
          basis: "not enough close comparable listings to estimate a price",
          disclaimer: DISCLAIMER,
        };
      }

      const weightedAverage = usableRows.reduce((sum, row) => sum + row.price * row.weight, 0) /
        usableRows.reduce((sum, row) => sum + row.weight, 0);

      const sortedPrices = usableRows
        .map((row) => row.price)
        .sort((a, b) => a - b);
      const lowIndex = Math.floor((sortedPrices.length - 1) * 0.25);
      const highIndex = Math.ceil((sortedPrices.length - 1) * 0.75);
      const low = sortedPrices[lowIndex];
      const high = sortedPrices[highIndex];

      return {
        amount: Math.round(weightedAverage),
        lowAmount: Math.round(low),
        highAmount: Math.round(high),
        currency: "THB",
        basis: `estimated from ${usableRows.length} close comparable listing${usableRows.length !== 1 ? "s" : ""}`,
        disclaimer: DISCLAIMER,
      };
    } catch {
      return { amount: null, lowAmount: null, highAmount: null, currency: "THB", basis: "unavailable", disclaimer: DISCLAIMER };
    }
  }

  private async loadImageBytes(mediaRows: MediaFileRow[]): Promise<ImageInput[]> {
    const rawBackendUrl = process.env.BACKEND_URL;
    const rawServerUrl = rawBackendUrl ?? (this.strapi.config.get("server.url") as string | undefined) ?? "http://localhost:1337";
    const normalizedServerUrl = rawServerUrl.match(/^https?:\/\//i)
      ? rawServerUrl
      : `http://${rawServerUrl}`;

    const images: ImageInput[] = [];
    for (const row of mediaRows) {
      const absoluteUrl = row.url.startsWith("http")
        ? row.url
        : new URL(row.url, normalizedServerUrl).toString();

      let response: Response;
      try {
        response = await fetch(absoluteUrl);
      } catch (error) {
        throw new Error(`Failed to fetch image ${row.id} from ${absoluteUrl}: ${(error as Error).message}`);
      }

      if (!response.ok) {
        throw new Error(`Failed to load image ${row.id} from ${absoluteUrl} (HTTP ${response.status}).`);
      }

      const arrayBuffer = await response.arrayBuffer();
      images.push({ data: Buffer.from(arrayBuffer), mimeType: row.mime });
    }
    return images;
  }

  private async buildPromptContext(categoryId: number | null): Promise<PromptContext> {
    const [categories, brands, materials, colors, conditions] = await Promise.all([
      this.strapi.entityService.findMany("api::category.category" as any, {
        fields: ["name"],
        filters: categoryId ? {} : { categories: { id: { $null: true } } },
        limit: 200,
      }),
      this.strapi.entityService.findMany("api::brand.brand" as any, {
        fields: ["name"],
        filters: categoryId ? { categories: { id: { $eq: categoryId } } } : {},
        limit: 200,
      }),
      this.strapi.entityService.findMany("api::material.material" as any, {
        fields: ["name"],
        filters: categoryId ? { categories: { id: { $eq: categoryId } } } : {},
        limit: 100,
      }),
      this.strapi.entityService.findMany("api::color.color" as any, {
        fields: ["name"],
        filters: categoryId ? { categories: { id: { $eq: categoryId } } } : {},
        limit: 100,
      }),
      this.strapi.entityService.findMany("api::condition.condition" as any, { fields: ["name"], limit: 20 }),
    ]);

    const names = (rows: unknown): string[] =>
      (rows as Array<{ name?: string | null }>).map((r) => r.name).filter((n): n is string => Boolean(n));

    return {
      candidateCategoryNames: names(categories),
      candidateBrandNames: names(brands),
      candidateMaterialNames: names(materials),
      candidateColorNames: names(colors),
      candidateConditionNames: names(conditions),
    };
  }

  private async logFailure(
    params: { userId: number; imageIds: number[]; categoryId: number | null; requestIp: string | null },
    failureReason: string,
    startedAt: number,
    modelVersion?: string,
  ): Promise<void> {
    this.strapi.log.error(`[listing-ai] analyze failed for user ${params.userId}: ${failureReason}`);
    try {
      await this.strapi.entityService.create("api::ai-request-log.ai-request-log" as any, {
        data: {
          users_permissions_user: params.userId,
          imageIds: params.imageIds,
          categoryId: params.categoryId,
          status: "failed",
          failureReason: failureReason.slice(0, 2000),
          modelVersion,
          ipAddress: params.requestIp,
          durationMs: Date.now() - startedAt,
        },
      });
    } catch (logError) {
      this.strapi.log.error(`[listing-ai] failed to write failure audit log: ${(logError as Error).message}`);
    }
  }

  private async logSuccess(
    params: { userId: number; imageIds: number[]; categoryId: number | null; requestIp: string | null },
    validatedResponse: any,
    modelVersion: string,
    startedAt: number,
  ): Promise<string> {
    const row = await this.strapi.entityService.create("api::ai-request-log.ai-request-log" as any, {
      data: {
        users_permissions_user: params.userId,
        imageIds: params.imageIds,
        categoryId: params.categoryId,
        status: "success",
        modelVersion,
        rawValidatedResponse: validatedResponse as any,
        ipAddress: params.requestIp,
        durationMs: Date.now() - startedAt,
      },
    });
    return String((row as { id: number }).id);
  }
}
