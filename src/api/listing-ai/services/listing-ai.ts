import type { Core } from "@strapi/strapi";
import { ListingAiOrchestrator } from "../../../lib/ai/listing-ai-orchestrator";

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  orchestrator: new ListingAiOrchestrator({ strapi }),
});
