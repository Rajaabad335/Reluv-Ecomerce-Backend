// seedCategoryAttributes.cjs
"use strict";

const fs = require("fs");
const path = require("path");
require("dotenv").config();

const BATCH_SIZE = 50;

async function seed() {
  const { createStrapi } = require("@strapi/strapi");

  const strapi = await createStrapi({
    appDir: __dirname,
    distDir: path.join(__dirname, "dist"),
  }).load();

  console.log("✓ Strapi booted\n");

  try {
    // ── Load JSON files ──────────────────────────────────────────────
    const attributeDefs = JSON.parse(
      fs.readFileSync(path.join(__dirname, "categoryAttributesUpdated.json"), "utf-8")
    );
    const slugToAttrCodes = JSON.parse(
      fs.readFileSync(path.join(__dirname, "categoryAttributeMappingUpdated.json"), "utf-8")
    );

    // ── Build maps ───────────────────────────────────────────────────
    const attrDefByCode = {};
    for (const attr of attributeDefs) {
      attrDefByCode[attr.code] = attr;
    }

    const attrCodeToSlugs = {};
    for (const [slug, codes] of Object.entries(slugToAttrCodes)) {
      for (const code of codes) {
        if (!attrCodeToSlugs[code]) attrCodeToSlugs[code] = [];
        attrCodeToSlugs[code].push(slug);
      }
    }

    const uniqueAttrCodes = Object.keys(attrCodeToSlugs);
    console.log(`Unique attribute codes    : ${uniqueAttrCodes.length}`);
    console.log(
      `Total category-attr pairs : ${Object.values(attrCodeToSlugs).reduce(
        (s, a) => s + a.length, 0
      )}\n`
    );

    // ── Load categories ──────────────────────────────────────────────
    let allCategories = await strapi
      .documents("api::category.category")
      .findMany({
        fields: ["documentId", "slug"],
        pagination: { limit: -1 },
        status: "published",
      });

    if (allCategories.length === 0) {
      console.warn("⚠  No published categories — retrying without status filter...");
      allCategories = await strapi
        .documents("api::category.category")
        .findMany({
          fields: ["documentId", "slug"],
          pagination: { limit: -1 },
        });
    }

    const categoryDocIdBySlug = {};
    for (const cat of allCategories) {
      categoryDocIdBySlug[cat.slug] = cat.documentId;
    }
    console.log(`✓ Loaded ${allCategories.length} categories`);

    // ── Load existing attributes ─────────────────────────────────────
    const existingAttrs = await strapi
      .documents("api::category-attribute.category-attribute")
      .findMany({
        fields: ["documentId", "code"],
        populate: { category_attribute_options: { fields: ["id", "value"] } },
        pagination: { limit: -1 },
      });

    const attrDocIdByCode = {};
    for (const attr of existingAttrs) {
      attrDocIdByCode[attr.code] = attr.documentId;
    }
    console.log(`✓ Loaded ${existingAttrs.length} existing attributes\n`);

    let created = 0;
    let updated = 0;
    let slugsMissing = 0;
    const errors = [];

    for (const [i, attrCode] of uniqueAttrCodes.entries()) {
      const progress = `[${i + 1}/${uniqueAttrCodes.length}]`;

      try {
        const attrDef = attrDefByCode[attrCode];
        if (!attrDef) {
          console.warn(`${progress} ⚠  No definition for "${attrCode}" — skipping`);
          continue;
        }

        // Resolve category documentIds
        const categoryConnects = [];
        for (const slug of attrCodeToSlugs[attrCode]) {
          const docId = categoryDocIdBySlug[slug];
          if (!docId) {
            slugsMissing++;
          } else {
            categoryConnects.push({ documentId: docId });
          }
        }

        const optionsData = (attrDef.options || []).map((opt, idx) => ({
          value: opt.value,
          sortOrder: opt.sortOrder ?? idx,
        }));

        // ── Base fields only (no relations) ───────────────────────────
        const basePayload = {
          name: attrDef.name,
          code: attrDef.code,
          type: attrDef.type,
          displayType: attrDef.displayType || "text",
          selectionType: attrDef.selectionType || "single",
          isRequired: attrDef.isRequired ?? false,
          placeholder: attrDef.placeholder || null,
          description: attrDef.description || null,
          selectionLimit: attrDef.selectionLimit || null,
        };

        const existingDocId = attrDocIdByCode[attrCode];
        let attrDocumentId = existingDocId;

        // ── Step 1: Create or update base record ──────────────────────
        if (!existingDocId) {
          // Include options only on first create
          const newAttr = await strapi
            .documents("api::category-attribute.category-attribute")
            .create({
              data: {
                ...basePayload,
                category_attribute_options: optionsData,
              },
              status: "published",
            });
          attrDocumentId = newAttr.documentId;
          created++;
          console.log(`${progress} ✓ Created [${attrCode}] "${attrDef.name}" (${optionsData.length} options)`);
        } else {
          // On update, only update base fields — don't touch options
          await strapi
            .documents("api::category-attribute.category-attribute")
            .update({
              documentId: existingDocId,
              data: basePayload,
              status: "published",
            });
          updated++;
          console.log(`${progress} ↺ Updated [${attrCode}] "${attrDef.name}"`);
        }

        // ── Step 2: Connect categories in small batches ───────────────
        // First remove all existing category links for clean re-seed
        const existingAttrFull = await strapi
          .documents("api::category-attribute.category-attribute")
          .findOne({
            documentId: attrDocumentId,
            populate: { categories: { fields: ["documentId"] } },
          });

        const existingCatDocIds = (existingAttrFull?.categories || []).map(
          (c) => ({ documentId: c.documentId })
        );

        if (existingCatDocIds.length > 0) {
          await strapi
            .documents("api::category-attribute.category-attribute")
            .update({
              documentId: attrDocumentId,
              data: { categories: { disconnect: existingCatDocIds } },
              status: "published",
            });
        }

        // Now connect in batches
        let linked = 0;
        for (let j = 0; j < categoryConnects.length; j += BATCH_SIZE) {
          const batch = categoryConnects.slice(j, j + BATCH_SIZE);
          await strapi
            .documents("api::category-attribute.category-attribute")
            .update({
              documentId: attrDocumentId,
              data: { categories: { connect: batch } },
              status: "published",
            });
          linked += batch.length;
          process.stdout.write(
            `\r     └─ Linking: ${linked}/${categoryConnects.length}   `
          );
        }
        console.log(
          `\n     └─ Done: ${linked} categories linked`
        );

      } catch (err) {
        // Print full error detail for debugging
        console.error(`\n${progress} ✗ ERROR [${attrCode}]: ${err.message}`);
        if (err.details) {
          console.error("  Details:", JSON.stringify(err.details, null, 2));
        }
        errors.push({ attrCode, error: err.message });
      }
    }

    // ── Summary ──────────────────────────────────────────────────────
    console.log("\n========== Seeding Summary ==========");
    console.log(`Total processed   : ${uniqueAttrCodes.length}`);
    console.log(`Created           : ${created}`);
    console.log(`Updated           : ${updated}`);
    console.log(`Slugs missing     : ${slugsMissing}`);
    console.log(`Errors            : ${errors.length}`);
    if (errors.length > 0) {
      console.log("\nFailed attributes:");
      errors.forEach(({ attrCode, error }) =>
        console.log(`  [${attrCode}] ${error}`)
      );
    }

    // ── Verify ───────────────────────────────────────────────────────
    const linkCount = await strapi.db
      .connection("category_attributes_categories_lnk")
      .count("id as count")
      .first();
    console.log(`\n✓ Link table rows : ${linkCount.count}`);
    console.log("=====================================");

  } finally {
    await strapi.destroy();
    console.log("✓ Strapi destroyed");
  }
}

seed()
  .then(() => {
    console.log("\nDone ✓");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\nFailed ✗", err);
    process.exit(1);
  });