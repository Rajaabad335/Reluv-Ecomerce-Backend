import { buildListingAnalysisPrompt, type PromptContext } from "./prompt";

interface GoogleGenAIInstance {
  models: {
    generateContent: (params: {
      model: string;
      contents: Array<{ role: string; parts: Array<{ text?: string; inlineData?: { data: string; mimeType: string } }> }>;
      config: { temperature: number; responseMimeType: string; abortSignal: AbortSignal };
    }) => Promise<{ text?: string }>;
  };
}

export interface ImageInput {
  data: Buffer;
  mimeType: string;
}

export type GeminiCallResult =
  | { ok: true; rawText: string; modelVersion: string }
  | { ok: false; reason: "timeout" | "provider_error" | "empty_response"; detail: string };

export interface GeminiClientOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
}

export class GeminiClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private sdkClient: GoogleGenAIInstance | null = null;

  constructor(options: GeminiClientOptions) {
    if (!options.apiKey) {
      throw new Error("GEMINI_API_KEY is not configured. Set it in the backend environment - never in frontend code.");
    }
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = options.maxRetries;
  }

  private async getSdkClient(): Promise<GoogleGenAIInstance> {
    if (this.sdkClient) return this.sdkClient;
    try {
      const { GoogleGenAI } = await import("@google/genai");
      this.sdkClient = new GoogleGenAI({ apiKey: this.apiKey });
      return this.sdkClient;
    } catch (err) {
      throw new Error("@google/genai SDK not available at runtime. Ensure provider SDK is installed and configured.");
    }
  }

  async analyzeListingImages(images: ImageInput[], promptContext: PromptContext): Promise<GeminiCallResult> {
    const prompt = buildListingAnalysisPrompt(promptContext);
    const client = await this.getSdkClient();

    const imageParts = images.map((image) => ({
      inlineData: { data: image.data.toString("base64"), mimeType: image.mimeType },
    }));

    let lastError = "Unknown error";

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await client.models.generateContent({
          model: this.model,
          contents: [{ role: "user", parts: [{ text: prompt }, ...imageParts] }],
          config: { temperature: 0.2, responseMimeType: "application/json", abortSignal: controller.signal },
        });

        clearTimeout(timeout);

        const rawText = response.text?.trim();
        if (!rawText) {
          lastError = "Gemini returned an empty response body.";
          continue;
        }

        return { ok: true, rawText, modelVersion: this.model };
      } catch (error) {
        clearTimeout(timeout);
        const isAbort = (error as Error)?.name === "AbortError";
        lastError = (error as Error)?.message ?? String(error);

        if (isAbort) {
          if (attempt === this.maxRetries) return { ok: false, reason: "timeout", detail: lastError };
          continue;
        }

        if (attempt === this.maxRetries) return { ok: false, reason: "provider_error", detail: lastError };
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }

    return { ok: false, reason: "provider_error", detail: lastError };
  }
}

let cachedClient: GeminiClient | null = null;

export function getGeminiClient(env: (key: string, fallback?: string) => string | undefined): GeminiClient {
  if (cachedClient) return cachedClient;

  const apiKey = env("GEMINI_API_KEY");
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set. Add it to backend/.env - it must never be exposed to the frontend.");
  }
  const model = env("GEMINI_MODEL", "gemini-3.6-flash") as string;
  const timeoutMs = Number(env("GEMINI_TIMEOUT_MS", "20000"));
  const maxRetries = Number(env("GEMINI_MAX_RETRIES", "1"));

  cachedClient = new GeminiClient({
    apiKey,
    model,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 20000,
    maxRetries: Number.isFinite(maxRetries) ? maxRetries : 1,
  });

  return cachedClient;
}
