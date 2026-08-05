import type { Core } from "@strapi/strapi";
import { getGeminiClient, type ImageInput } from "./gemini-client";
import { parseGeminiResponse } from "./schemas";
import { resolveAllFields } from "./db-resolver";
import { LuxuryService } from "./luxury-service";
import type { PromptContext } from "./prompt";
import type { AnalyzeListingResult, ResolvedSuggestions } from "./types";

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

      const requestId = await this.logSuccess(params, (parsed as { ok: true; data: any }).data, geminiResult.modelVersion, startedAt);

      return { ok: true, result: { requestId, suggestions, luxury, modelVersion: geminiResult.modelVersion } };
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

      return {
        ok: true,
        result: {
          requestId: params.requestId,
          suggestions,
          luxury,
          modelVersion: (logRow as { modelVersion?: string }).modelVersion ?? "unknown",
        },
      };
    } catch (error) {
      return { ok: false, httpStatus: 500, message: `Failed to rescope suggestion: ${(error as Error).message}` };
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
