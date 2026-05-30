const fs = require("fs");
const path = require("path");
const { compileStrapi, createStrapi } = require("@strapi/core");

async function seedCategoryAttributes(strapi) {
  try {
    console.log("Category attribute seeding started...");

    const filePath = path.join(process.cwd(), "categoryAttributes.json");

    if (!fs.existsSync(filePath)) {
      throw new Error(`Seed file not found: ${filePath}`);
    }

    const attributes = JSON.parse(fs.readFileSync(filePath, "utf-8"));

    let attrCreated = 0;
    let attrSkipped = 0;
    let optCreated = 0;
    let optSkipped = 0;

    for (const attr of attributes) {
      // Check if attribute already exists by code
      const existing = await strapi
        .documents("api::category-attribute.category-attribute")
        .findFirst({ filters: { code: attr.code } });

      let attrRecord;

      if (existing) {
        attrRecord = existing;
        attrSkipped++;
        console.log(`Exists (attribute): ${attr.name} [${attr.code}]`);
      } else {
        attrRecord = await strapi.entityService.create(
          "api::category-attribute.category-attribute",
          {
            data: {
              name: attr.name,
              code: attr.code,
              type: attr.type,
              displayType: attr.displayType,
              selectionType: attr.selectionType,
              isRequired: attr.isRequired,
              placeholder: attr.placeholder || null,
              description: attr.description || null,
            },
          }
        );
        attrCreated++;
        console.log(`Created (attribute): ${attr.name} [${attr.code}]`);
      }

      // Seed options for this attribute
      if (attr.options && attr.options.length > 0) {
        for (const opt of attr.options) {
          const existingOpt = await strapi
            .documents("api::category-attribute-option.category-attribute-option")
            .findFirst({
              filters: {
                value: opt.value,
                category_attribute: { id: attrRecord.id },
              },
            });

          if (existingOpt) {
            optSkipped++;
          } else {
            await strapi.entityService.create(
              "api::category-attribute-option.category-attribute-option",
              {
                data: {
                  value: opt.value,
                  sortOrder: opt.sortOrder,
                  category_attribute: attrRecord.id,
                },
              }
            );
            optCreated++;
          }
        }
        console.log(
          `  → Options: ${attr.options.length} total (${optCreated} new so far)`
        );
      }
    }

    console.log("\n========== Seeding Summary ==========");
    console.log(`Attributes created : ${attrCreated}`);
    console.log(`Attributes skipped : ${attrSkipped}`);
    console.log(`Options created    : ${optCreated}`);
    console.log(`Options skipped    : ${optSkipped}`);
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
