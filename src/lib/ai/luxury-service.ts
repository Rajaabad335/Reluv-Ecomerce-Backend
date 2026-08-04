import type { Core } from "@strapi/strapi";
import type { ValidatedGeminiLuxurySignal } from "./schemas";
import type { LuxuryAssessment, LuxuryEvidenceFlags, ResolvedField } from "./types";

const EVIDENCE_LABELS: Record<keyof LuxuryEvidenceFlags, string> = {
  receiptDetected: "Original receipt",
  invoiceDetected: "Invoice",
  authenticityCardDetected: "Authenticity card",
  warrantyCardDetected: "Warranty card",
  serialNumberDetected: "Serial number",
  qrCodeDetected: "QR code",
  nfcTagDetected: "NFC tag",
  logoCloseUpDetected: "Close-up logo photo",
  hardwarePhotoDetected: "Hardware photo",
  stitchingPhotoDetected: "Stitching photo",
  careLabelDetected: "Care label",
  materialLabelDetected: "Material label",
};

const EVIDENCE_KEY_TO_CONFIG_CODE: Record<keyof LuxuryEvidenceFlags, string> = {
  receiptDetected: "receipt",
  invoiceDetected: "invoice",
  authenticityCardDetected: "authenticityCard",
  warrantyCardDetected: "warrantyCard",
  serialNumberDetected: "serialNumber",
  qrCodeDetected: "qrCode",
  nfcTagDetected: "nfcTag",
  logoCloseUpDetected: "logoCloseUp",
  hardwarePhotoDetected: "hardwarePhoto",
  stitchingPhotoDetected: "stitchingPhoto",
  careLabelDetected: "careLabel",
  materialLabelDetected: "materialLabel",
};

interface LuxuryBrandConfigRow {
  id: number;
  isActive: boolean;
  requiredEvidenceTypes: unknown;
  brand?: { id: number; name?: string } | null;
}

export class LuxuryService {
  private readonly strapi: Core.Strapi;

  constructor(deps: { strapi: Core.Strapi }) {
    this.strapi = deps.strapi;
  }

  async assess(resolvedBrand: ResolvedField, luxurySignal: ValidatedGeminiLuxurySignal): Promise<LuxuryAssessment> {
    const evidence: LuxuryEvidenceFlags = {
      receiptDetected: luxurySignal.receiptDetected,
      invoiceDetected: luxurySignal.invoiceDetected,
      authenticityCardDetected: luxurySignal.authenticityCardDetected,
      warrantyCardDetected: luxurySignal.warrantyCardDetected,
      serialNumberDetected: luxurySignal.serialNumberDetected,
      qrCodeDetected: luxurySignal.qrCodeDetected,
      nfcTagDetected: luxurySignal.nfcTagDetected,
      logoCloseUpDetected: luxurySignal.logoCloseUpDetected,
      hardwarePhotoDetected: luxurySignal.hardwarePhotoDetected,
      stitchingPhotoDetected: luxurySignal.stitchingPhotoDetected,
      careLabelDetected: luxurySignal.careLabelDetected,
      materialLabelDetected: luxurySignal.materialLabelDetected,
    };

    if (!resolvedBrand.resolvedId) {
      return { isLuxury: false, matchedBrandConfigId: null, matchedBrandName: null, evidence, missingEvidence: [], aiNotes: luxurySignal.notes };
    }

    const configRows = (await this.strapi.entityService.findMany("api::luxury-brand-config.luxury-brand-config", {
      filters: { brand: { id: { $eq: resolvedBrand.resolvedId } }, isActive: { $eq: true } },
      populate: { brand: { fields: ["id", "name"] } },
      limit: 1,
    })) as unknown as LuxuryBrandConfigRow[];

    const config = configRows[0];
    if (!config) {
      return { isLuxury: false, matchedBrandConfigId: null, matchedBrandName: resolvedBrand.resolvedLabel, evidence, missingEvidence: [], aiNotes: luxurySignal.notes };
    }

    const requiredCodes = Array.isArray(config.requiredEvidenceTypes) ? (config.requiredEvidenceTypes as string[]) : [];

    const missingEvidence = (Object.keys(EVIDENCE_KEY_TO_CONFIG_CODE) as Array<keyof LuxuryEvidenceFlags>)
      .filter((key) => requiredCodes.includes(EVIDENCE_KEY_TO_CONFIG_CODE[key]))
      .filter((key) => !evidence[key])
      .map((key) => EVIDENCE_LABELS[key]);

    return {
      isLuxury: true,
      matchedBrandConfigId: config.id,
      matchedBrandName: config.brand?.name ?? resolvedBrand.resolvedLabel,
      evidence,
      missingEvidence,
      aiNotes: luxurySignal.notes,
    };
  }
}
