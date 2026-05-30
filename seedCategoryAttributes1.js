const fs = require("fs");
const path = require("path");
const { compileStrapi, createStrapi } = require("@strapi/core");

async function seedCategoryAttributes(strapi) {
  try {
    console.log("Category attribute seeding started...");

    // ── 1. Load source files ─────────────────────────────────────────────────
    const attrsFilePath = path.join(process.cwd(), "categoryAttributes.json");
    const mappingFilePath = path.join(
      process.cwd(),
      "categoryAttributeMapping.json"
    );

    if (!fs.existsSync(attrsFilePath))
      throw new Error(`File not found: ${attrsFilePath}`);
    if (!fs.existsSync(mappingFilePath))
      throw new Error(`File not found: ${mappingFilePath}`);

    const attributes = JSON.parse(fs.readFileSync(attrsFilePath, "utf-8"));
    // { "women": ["brand","condition",...], "men": [...], ... }
    const slugToAttrCodes = JSON.parse(
      fs.readFileSync(mappingFilePath, "utf-8")
    );

    // ── 2. attrCode → attribute definition lookup ────────────────────────────
    const attrDefByCode = {};
    for (const attr of attributes) {
      attrDefByCode[attr.code] = attr;
    }

    // ── 3. Load root categories from DB → slug → documentId ─────────────────
    console.log("Loading root categories from DB...");
    const rootSlugs = Object.keys(slugToAttrCodes);

    const allCategories = await strapi
      .documents("api::category.category")
      .findMany({
        filters: { slug: { $in: rootSlugs } },
        fields: ["documentId", "slug", "name"],
        pagination: { limit: -1 },
      });

    const categoryBySlug = {};
    for (const cat of allCategories) {
      categoryBySlug[cat.slug] = cat;
    }

    console.log(`Found ${allCategories.length} root categories in DB.`);
    console.log(
      `Root slugs found: ${allCategories.map((c) => c.slug).join(", ")}`
    );

    // ── 4. Seed ──────────────────────────────────────────────────────────────
    let attrCreated = 0;
    let attrSkipped = 0;
    let optCreated = 0;
    let optSkipped = 0;
    let catMissing = 0;

    for (const [categorySlug, attrCodes] of Object.entries(slugToAttrCodes)) {
      const categoryRecord = categoryBySlug[categorySlug];

      if (!categoryRecord) {
        console.warn(`  ⚠  Category not found in DB: "${categorySlug}"`);
        catMissing++;
        continue;
      }

      console.log(
        `\n► [${categoryRecord.name}] — ${attrCodes.length} attribute(s)`
      );

      for (const attrCode of attrCodes) {
        const attrDef = attrDefByCode[attrCode];
        if (!attrDef) {
          console.warn(
            `    ⚠  No definition for code "${attrCode}" — skipping`
          );
          continue;
        }

        // Check if this attribute already exists for this root category
        const existing = await strapi
          .documents("api::category-attribute.category-attribute")
          .findFirst({
            filters: {
              code: attrCode,
              category: { documentId: categoryRecord.documentId },
            },
          });

        let attrDocumentId;

        if (existing) {
          attrDocumentId = existing.documentId;
          attrSkipped++;
          console.log(`    ↩  Exists: ${attrDef.name} [${attrCode}]`);
        } else {
          const created = await strapi
            .documents("api::category-attribute.category-attribute")
            .create({
              data: {
                name: attrDef.name,
                code: attrDef.code,
                type: attrDef.type,
                displayType: attrDef.displayType,
                selectionType: attrDef.selectionType,
                isRequired: attrDef.isRequired,
                placeholder: attrDef.placeholder || null,
                description: attrDef.description || null,
                category: categoryRecord.documentId,
              },
            });
          attrDocumentId = created.documentId;
          attrCreated++;
          console.log(`    ✓  Created: ${attrDef.name} [${attrCode}]`);
        }

        // ── Seed options for this attribute ──────────────────────────────────
        if (attrDef.options?.length > 0) {
          let newOpts = 0;
          for (const opt of attrDef.options) {
            const existingOpt = await strapi
              .documents(
                "api::category-attribute-option.category-attribute-option"
              )
              .findFirst({
                filters: {
                  value: opt.value,
                  category_attribute: { documentId: attrDocumentId },
                },
              });

            if (existingOpt) {
              optSkipped++;
            } else {
              await strapi
                .documents(
                  "api::category-attribute-option.category-attribute-option"
                )
                .create({
                  data: {
                    value: opt.value,
                    sortOrder: opt.sortOrder,
                    category_attribute: attrDocumentId,
                  },
                });
              optCreated++;
              newOpts++;
            }
          }
          console.log(
            `       └─ Options: ${newOpts} new / ${attrDef.options.length - newOpts} existing`
          );
        }
      }
    }

    // ── 5. Summary ───────────────────────────────────────────────────────────
    console.log("\n========== Seeding Summary ==========");
    console.log(`Root categories processed : ${Object.keys(slugToAttrCodes).length}`);
    console.log(`Categories missing in DB  : ${catMissing}`);
    console.log(`Attributes created        : ${attrCreated}`);
    console.log(`Attributes skipped        : ${attrSkipped}`);
    console.log(`Options created           : ${optCreated}`);
    console.log(`Options skipped           : ${optSkipped}`);
    console.log("=====================================");
    console.log("Category attribute seeding completed.");
  } catch (error) {
    console.error("Category attribute seeding failed:", error);
    throw error;
  }
}

module.exports = async ({ strapi }) => {
  await seedCategoryAttributes(strapi);
};

module.exports.seedCategoryAttributes = seedCategoryAttributes;

async function runFromCli() {
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  try {
    await seedCategoryAttributes(app);
  } finally {
    await app.destroy();
  }
}

if (require.main === module) {
  runFromCli()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("Seed command failed:", error);
      process.exit(1);
    });
}
