import { z } from "zod";

export const analyzeListingRequestSchema = z.object({
  categoryId: z.number().int().positive().nullable().optional(),
  imageIds: z
    .array(z.number().int().positive())
    .min(1, "At least one image is required.")
    .max(6, "A maximum of 6 images is allowed."),
});
export type AnalyzeListingRequest = z.infer<typeof analyzeListingRequestSchema>;

export const submitLuxuryEvidenceRequestSchema = z.object({
  productId: z.number().int().positive(),
  receiptImageIds: z.array(z.number().int().positive()).max(6).optional().default([]),
  invoiceImageIds: z.array(z.number().int().positive()).max(6).optional().default([]),
  authenticityCardImageIds: z.array(z.number().int().positive()).max(6).optional().default([]),
  warrantyCardImageIds: z.array(z.number().int().positive()).max(6).optional().default([]),
  serialNumberImageIds: z.array(z.number().int().positive()).max(6).optional().default([]),
  qrCodeImageIds: z.array(z.number().int().positive()).max(6).optional().default([]),
  nfcTagImageIds: z.array(z.number().int().positive()).max(6).optional().default([]),
  logoCloseUpImageIds: z.array(z.number().int().positive()).max(10).optional().default([]),
  hardwarePhotoImageIds: z.array(z.number().int().positive()).max(10).optional().default([]),
  stitchingPhotoImageIds: z.array(z.number().int().positive()).max(10).optional().default([]),
  careLabelImageIds: z.array(z.number().int().positive()).max(6).optional().default([]),
  materialLabelImageIds: z.array(z.number().int().positive()).max(6).optional().default([]),
});
export type SubmitLuxuryEvidenceRequest = z.infer<typeof submitLuxuryEvidenceRequestSchema>;

export const verificationDecisionRequestSchema = z.object({
  decision: z.enum(["approve", "reject", "request_more_evidence"]),
  adminNotes: z.string().trim().max(2000).optional().default(""),
});
export type VerificationDecisionRequest = z.infer<typeof verificationDecisionRequestSchema>;

const confidenceSchema = z
  .number()
  .finite()
  .transform((value) => Math.max(0, Math.min(100, value)));

const detectedFieldSchema = z.object({
  value: z
    .string()
    .trim()
    .max(500)
    .nullable()
    .transform((value) => (value && value.length > 0 ? value : null)),
  confidence: confidenceSchema,
});

export const geminiSuggestionSchema = z.object({
  category: detectedFieldSchema,
  subcategory: detectedFieldSchema,
  brand: detectedFieldSchema,
  primaryColor: detectedFieldSchema,
  secondaryColor: detectedFieldSchema,
  material: detectedFieldSchema,
  condition: detectedFieldSchema,
  gender: detectedFieldSchema,
  style: detectedFieldSchema,
  title: z.object({ value: z.string().trim().max(120).nullable(), confidence: confidenceSchema }),
  description: z.object({ value: z.string().trim().max(2000).nullable(), confidence: confidenceSchema }),
});
export type ValidatedGeminiSuggestion = z.infer<typeof geminiSuggestionSchema>;

export const geminiLuxurySignalSchema = z.object({
  luxuryBrandSuspected: z.boolean(),
  receiptDetected: z.boolean(),
  invoiceDetected: z.boolean(),
  authenticityCardDetected: z.boolean(),
  warrantyCardDetected: z.boolean(),
  serialNumberDetected: z.boolean(),
  qrCodeDetected: z.boolean(),
  nfcTagDetected: z.boolean(),
  logoCloseUpDetected: z.boolean(),
  hardwarePhotoDetected: z.boolean(),
  stitchingPhotoDetected: z.boolean(),
  careLabelDetected: z.boolean(),
  materialLabelDetected: z.boolean(),
  notes: z.string().trim().max(1000).default(""),
});
export type ValidatedGeminiLuxurySignal = z.infer<typeof geminiLuxurySignalSchema>;

export const geminiResponseEnvelopeSchema = z.object({
  suggestion: geminiSuggestionSchema,
  luxurySignal: geminiLuxurySignalSchema,
});
export type ValidatedGeminiResponse = z.infer<typeof geminiResponseEnvelopeSchema>;

export type ParseResult =
  | { ok: true; data: ValidatedGeminiResponse }
  | { ok: false; error: string; rawText: string };

export function parseGeminiResponse(rawText: string): ParseResult {
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(cleaned);
  } catch (error) {
    return { ok: false, error: `Gemini response was not valid JSON: ${(error as Error).message}`, rawText };
  }

  const result = geminiResponseEnvelopeSchema.safeParse(parsedJson);
  if (!result.success) {
    return { ok: false, error: `Gemini response failed schema validation: ${result.error.message}`, rawText };
  }

  return { ok: true, data: result.data };
}
