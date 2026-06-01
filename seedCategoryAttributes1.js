const fs = require("fs");
const path = require("path");
const { compileStrapi, createStrapi } = require("@strapi/core");
const RELATION_BATCH_SIZE = 50;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function connectInBatches(strapi, documentId, documentIds) {
  const total = documentIds.length;
  for (let i = 0; i < total; i += RELATION_BATCH_SIZE) {
    const batch = documentIds.slice(i, i + RELATION_BATCH_SIZE);
    await strapi
      .documents("api::category-attribute.category-attribute")
      .update({
        documentId,
        data: {
          categories: {
            connect: batch.map((id) => ({ documentId: id })),
          },
        },
      });
    if (i + RELATION_BATCH_SIZE < total) await sleep(50);
  }
}

async function seedCategoryAttributes(strapi) {
  try {
    console.log("Category attribute seeding started...");

    const attrsFilePath = path.join(process.cwd(), "categoryAttributes.json");
    const mappingFilePath = path.join(
      process.cwd(),
      "categoryAttributeMapping.json"
    );

    if (!fs.existsSync(attrsFilePath))
      throw new Error(`File not found: ${attrsFilePath}`);
    if (!fs.existsSync(mappingFilePath))
      throw new Error(`File not found: ${mappingFilePath}`);

    const attributeDefs = JSON.parse(fs.readFileSync(attrsFilePath, "utf-8"));
    const slugToAttrCodes = JSON.parse(
      fs.readFileSync(mappingFilePath, "utf-8")
    );

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
    console.log(`Unique attribute codes : ${uniqueAttrCodes.length}`);
    console.log(
      `Total category-attr pairs : ${Object.values(attrCodeToSlugs).reduce(
        (s, a) => s + a.length,
        0
      )}`
    );

    console.log("\nLoading all categories from DB...");

    const categoryDocIdBySlug = {};
    const PAGE_SIZE = 100;
    let offset = 0;

    while (true) {
      const batch = await strapi
        .documents("api::category.category")
        .findMany({
          fields: ["slug"],
          limit: PAGE_SIZE,
          start: offset,
        });

      if (!batch || batch.length === 0) break;

      for (const cat of batch) {
        categoryDocIdBySlug[cat.slug] = cat.documentId;
      }

      console.log(
        `  offset ${offset} → loaded ${batch.length} (total: ${
          offset + batch.length
        })`
      );

      if (batch.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    console.log(
      `\nTotal categories loaded from DB: ${
        Object.keys(categoryDocIdBySlug).length
      }\n`
    );

    let attrCreated = 0;
    let attrSkipped = 0;
    let optCreated = 0;
    let optSkipped = 0;
    let slugsMissing = 0;
    const errors = [];

    for (const attrCode of uniqueAttrCodes) {
      try {
        const attrDef = attrDefByCode[attrCode];

        if (!attrDef) {
          console.warn(`⚠  No definition for code "${attrCode}" — skipping`);
          continue;
        }

        const categoryDocumentIds = [];
        for (const slug of attrCodeToSlugs[attrCode]) {
          const docId = categoryDocIdBySlug[slug];
          if (!docId) {
            console.warn(`  ⚠  Slug not in DB: "${slug}"`);
            slugsMissing++;
          } else {
            categoryDocumentIds.push(docId);
          }
        }

        const existing = await strapi
          .documents("api::category-attribute.category-attribute")
          .findFirst({
            filters: { code: { $eq: attrCode } },
            populate: {
              categories: { fields: ["id"] },
            },
          });

        let attrDocumentId;

        if (existing) {
          attrDocumentId = existing.documentId;
          attrSkipped++;

          const alreadyLinkedIds = new Set(
            (existing.categories || []).map((c) => c.documentId)
          );
          const newConnections = categoryDocumentIds.filter(
            (id) => !alreadyLinkedIds.has(id)
          );

          if (newConnections.length > 0) {
            await connectInBatches(strapi, attrDocumentId, newConnections);
            console.log(
              `  ↩  Exists [${attrCode}] — connected ${newConnections.length} new categories in batches`
            );
          } else {
            console.log(
              `  ↩  Exists [${attrCode}] — all ${categoryDocumentIds.length} categories already linked`
            );
          }
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
                placeholder: attrDef.placeholder ?? null,
                description: attrDef.description ?? null,
                selectionLimit: attrDef.selectionLimit ?? null,
              },
            });

          attrDocumentId = created.documentId;
          attrCreated++;

          if (categoryDocumentIds.length > 0) {
            await connectInBatches(strapi, attrDocumentId, categoryDocumentIds);
          }

          console.log(
            `  ✓  Created [${attrCode}] "${attrDef.name}" → linked to ${categoryDocumentIds.length} categories`
          );
        }

        if (attrDef.options?.length > 0) {
          let newOpts = 0;
          let existingOpts = 0;

          for (const opt of attrDef.options) {
            const existingOpt = await strapi
              .documents(
                "api::category-attribute-option.category-attribute-option"
              )
              .findFirst({
                filters: {
                  value: { $eq: opt.value },
                  category_attribute: { documentId: { $eq: attrDocumentId } },
                },
              });

            if (existingOpt) {
              optSkipped++;
              existingOpts++;
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
            `     └─ Options: ${newOpts} created / ${existingOpts} already existed`
          );
        }
      } catch (err) {
        console.error(`  ✗  ERROR on [${attrCode}]: ${err.message}`);
        errors.push({ attrCode, error: err.message });
      }
    }

    console.log("\n========== Seeding Summary ==========");
    console.log(`Unique attributes total    : ${uniqueAttrCodes.length}`);
    console.log(`Attributes created         : ${attrCreated}`);
    console.log(`Attributes already existed : ${attrSkipped}`);
    console.log(`Options created            : ${optCreated}`);
    console.log(`Options already existed    : ${optSkipped}`);
    console.log(`Category slugs missing     : ${slugsMissing}`);
    console.log(`Errors                     : ${errors.length}`);
    if (errors.length > 0) {
      console.log("\nFailed attributes:");
      errors.forEach(({ attrCode, error }) =>
        console.log(`  [${attrCode}] ${error}`)
      );
    }
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