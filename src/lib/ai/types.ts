export type DetectedFieldName =
  | "category"
  | "subcategory"
  | "brand"
  | "primaryColor"
  | "secondaryColor"
  | "material"
  | "condition"
  | "gender"
  | "style"
  | "title"
  | "description";

export interface RawDetectedField {
  value: string | null;
  confidence: number;
}

export type RawGeminiSuggestion = Record<DetectedFieldName, RawDetectedField>;

export type SuggestionTier = "auto" | "suggested" | "unknown";

export interface ResolvedField {
  rawValue: string | null;
  confidence: number;
  tier: SuggestionTier;
  resolvedId: number | null;
  resolvedLabel: string | null;
  attributeCode?: string | null;
}

export interface ResolvedTextField {
  rawValue: string | null;
  confidence: number;
  tier: SuggestionTier;
  text: string | null;
}

export interface ResolvedSuggestions {
  category: ResolvedField;
  subcategory: ResolvedField;
  brand: ResolvedField;
  primaryColor: ResolvedField;
  secondaryColor: ResolvedField;
  material: ResolvedField;
  condition: ResolvedField;
  gender: ResolvedField;
  style: ResolvedField;
  title: ResolvedTextField;
  description: ResolvedTextField;
}

export interface LuxuryEvidenceFlags {
  receiptDetected: boolean;
  invoiceDetected: boolean;
  authenticityCardDetected: boolean;
  warrantyCardDetected: boolean;
  serialNumberDetected: boolean;
  qrCodeDetected: boolean;
  nfcTagDetected: boolean;
  logoCloseUpDetected: boolean;
  hardwarePhotoDetected: boolean;
  stitchingPhotoDetected: boolean;
  careLabelDetected: boolean;
  materialLabelDetected: boolean;
}

export interface LuxuryAssessment {
  isLuxury: boolean;
  matchedBrandConfigId: number | null;
  matchedBrandName: string | null;
  evidence: LuxuryEvidenceFlags;
  missingEvidence: string[];
  aiNotes: string;
}

export interface AnalyzeListingResult {
  requestId: string;
  suggestions: ResolvedSuggestions;
  luxury: LuxuryAssessment;
  modelVersion: string;
}
