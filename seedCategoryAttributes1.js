// const fs = require("fs");
// const path = require("path");
// const { compileStrapi, createStrapi } = require("@strapi/core");

// async function seedCategoryAttributes(strapi) {
//   try {
//     console.log("Category attribute seeding started...");

//     // ── 1. Load source files ───────────────────────────────────────────────
//     const attrsFilePath = path.join(process.cwd(), "categoryAttributes1.json");
//     const mappingFilePath = path.join(
//       process.cwd(),
//       "categoryAttributeMapping.json"
//     );

//     if (!fs.existsSync(attrsFilePath)) {
//       throw new Error(`Seed file not found: ${attrsFilePath}`);
//     }
//     if (!fs.existsSync(mappingFilePath)) {
//       throw new Error(`Mapping file not found: ${mappingFilePath}`);
//     }

//     const attributes = JSON.parse(fs.readFileSync(attrsFilePath, "utf-8"));
//     // slugToAttrCodes: { [categorySlug]: string[] }
//     const slugToAttrCodes = JSON.parse(fs.readFileSync(mappingFilePath, "utf-8"));

//     // ── 2. Build a lookup: attrCode → attribute definition ─────────────────
//     const attrDefByCode = {};
//     for (const attr of attributes) {
//       attrDefByCode[attr.code] = attr;
//     }

//     // ── 3. Build a lookup: categorySlug → category DB record ──────────────
//     console.log("Loading all categories from DB...");
//     const allCategories = await strapi
//       .documents("api::category.category")
//       .findMany({ fields: ["id", "slug"], pagination: { limit: -1 } });

//     const categoryBySlug = {};
//     for (const cat of allCategories) {
//       categoryBySlug[cat.slug] = cat;
//     }
//     console.log(`Loaded ${allCategories.length} categories.`);

//     // ── 4. Seed attributes per category ────────────────────────────────────
//     let attrCreated = 0;
//     let attrSkipped = 0;
//     let optCreated = 0;
//     let optSkipped = 0;
//     let catMissing = 0;

//     for (const [categorySlug, attrCodes] of Object.entries(slugToAttrCodes)) {
//       const categoryRecord = categoryBySlug[categorySlug];

//       if (!categoryRecord) {
//         console.warn(`  ⚠ Category not found in DB: ${categorySlug}`);
//         catMissing++;
//         continue;
//       }

//       for (const attrCode of attrCodes) {
//         const attrDef = attrDefByCode[attrCode];
//         if (!attrDef) {
//           console.warn(
//             `  ⚠ No attribute definition for code "${attrCode}" (category: ${categorySlug})`
//           );
//           continue;
//         }

//         // ── Check if this attribute already exists for this category ──────
//         const existing = await strapi
//           .documents("api::category-attribute.category-attribute")
//           .findFirst({
//             filters: {
//               code: attrCode,
//               category: { id: categoryRecord.id },
//             },
//           });

//         let attrRecord;

//         if (existing) {
//           attrRecord = existing;
//           attrSkipped++;
//         } else {
//           attrRecord = await strapi.entityService.create(
//             "api::category-attribute.category-attribute",
//             {
//               data: {
//                 name: attrDef.name,
//                 code: attrDef.code,
//                 type: attrDef.type,
//                 displayType: attrDef.displayType,
//                 selectionType: attrDef.selectionType,
//                 isRequired: attrDef.isRequired,
//                 placeholder: attrDef.placeholder || null,
//                 description: attrDef.description || null,
//                 // ── Link to the category ──────────────────────────────────
//                 category: categoryRecord.id,
//               },
//             }
//           );
//           attrCreated++;
//         }

//         // ── Seed options for this attribute instance ───────────────────────
//         if (attrDef.options && attrDef.options.length > 0) {
//           for (const opt of attrDef.options) {
//             const existingOpt = await strapi
//               .documents(
//                 "api::category-attribute-option.category-attribute-option"
//               )
//               .findFirst({
//                 filters: {
//                   value: opt.value,
//                   category_attribute: { id: attrRecord.id },
//                 },
//               });

//             if (existingOpt) {
//               optSkipped++;
//             } else {
//               await strapi.entityService.create(
//                 "api::category-attribute-option.category-attribute-option",
//                 {
//                   data: {
//                     value: opt.value,
//                     sortOrder: opt.sortOrder,
//                     category_attribute: attrRecord.id,
//                   },
//                 }
//               );
//               optCreated++;
//             }
//           }
//         }
//       }

//       console.log(
//         `  ✓ ${categorySlug} → ${attrCodes.length} attribute(s) processed`
//       );
//     }

//     // ── 5. Summary ──────────────────────────────────────────────────────────
//     console.log("\n========== Seeding Summary ==========");
//     console.log(`Attributes created : ${attrCreated}`);
//     console.log(`Attributes skipped : ${attrSkipped}`);
//     console.log(`Options created    : ${optCreated}`);
//     console.log(`Options skipped    : ${optSkipped}`);
//     console.log(`Categories missing : ${catMissing}`);
//     console.log("=====================================");
//     console.log("Category attribute seeding completed.");
//   } catch (error) {
//     console.error("Category attribute seeding failed:", error);
//     throw error;
//   }
// }

// module.exports = async ({ strapi }) => {
//   await seedCategoryAttributes(strapi);
// };

// module.exports.seedCategoryAttributes = seedCategoryAttributes;

// async function runFromCli() {
//   const appContext = await compileStrapi();
//   const app = await createStrapi(appContext).load();

//   try {
//     await seedCategoryAttributes(app);
//   } finally {
//     await app.destroy();
//   }
// }

// if (require.main === module) {
//   runFromCli()
//     .then(() => {
//       process.exit(0);
//     })
//     .catch((error) => {
//       console.error("Seed command failed:", error);
//       process.exit(1);
//     });
// }







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

    if (!fs.existsSync(attrsFilePath)) {
      throw new Error(`Seed file not found: ${attrsFilePath}`);
    }
    if (!fs.existsSync(mappingFilePath)) {
      throw new Error(`Mapping file not found: ${mappingFilePath}`);
    }

    const attributes = JSON.parse(fs.readFileSync(attrsFilePath, "utf-8"));
    const slugToAttrCodes = JSON.parse(
      fs.readFileSync(mappingFilePath, "utf-8")
    );

    // ── 2. Build attrCode → attribute definition lookup ──────────────────────
    const attrDefByCode = {};
    for (const attr of attributes) {
      attrDefByCode[attr.code] = attr;
    }

    // ── 3. Load all categories → build slug → documentId lookup ─────────────
    console.log("Loading all categories from DB...");
    const allCategories = await strapi
      .documents("api::category.category")
      .findMany({ fields: ["documentId", "slug"], pagination: { limit: -1 } });

    const categoryDocIdBySlug = {};
    for (const cat of allCategories) {
      categoryDocIdBySlug[cat.slug] = cat.documentId;
    }
    console.log(`Loaded ${allCategories.length} categories.`);

    // ── 4. Seed attributes per category ──────────────────────────────────────
    let attrCreated = 0;
    let attrSkipped = 0;
    let optCreated = 0;
    let optSkipped = 0;
    let catMissing = 0;

    for (const [categorySlug, attrCodes] of Object.entries(slugToAttrCodes)) {
      const categoryDocumentId = categoryDocIdBySlug[categorySlug];

      if (!categoryDocumentId) {
        console.warn(`  ⚠ Category not found in DB: ${categorySlug}`);
        catMissing++;
        continue;
      }

      for (const attrCode of attrCodes) {
        const attrDef = attrDefByCode[attrCode];
        if (!attrDef) {
          console.warn(
            `  ⚠ No definition for code "${attrCode}" (category: ${categorySlug})`
          );
          continue;
        }

        // Check if this attribute already exists for this category
        const existing = await strapi
          .documents("api::category-attribute.category-attribute")
          .findFirst({
            filters: {
              code: attrCode,
              category: { documentId: categoryDocumentId },
            },
          });

        let attrDocumentId;

        if (existing) {
          attrDocumentId = existing.documentId;
          attrSkipped++;
        } else {
          // Use documents API throughout — it handles relation connect correctly
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
                // Strapi v5 documents API: pass documentId for relations
                category: categoryDocumentId,
              },
            });
          attrDocumentId = created.documentId;
          attrCreated++;
        }

        // ── Seed options for this attribute instance ───────────────────────
        if (attrDef.options && attrDef.options.length > 0) {
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
                    // Strapi v5: pass documentId for relations
                    category_attribute: attrDocumentId,
                  },
                });
              optCreated++;
            }
          }
        }
      }

      console.log(
        `  ✓ ${categorySlug} → ${attrCodes.length} attribute(s) processed`
      );
    }

    // ── 5. Summary ───────────────────────────────────────────────────────────
    console.log("\n========== Seeding Summary ==========");
    console.log(`Attributes created : ${attrCreated}`);
    console.log(`Attributes skipped : ${attrSkipped}`);
    console.log(`Options created    : ${optCreated}`);
    console.log(`Options skipped    : ${optSkipped}`);
    console.log(`Categories missing : ${catMissing}`);
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
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error("Seed command failed:", error);
      process.exit(1);
    });
}
