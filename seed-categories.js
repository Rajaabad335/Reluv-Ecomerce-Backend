const fs = require("fs");
const path = require("path");
const { compileStrapi, createStrapi } = require("@strapi/core");

async function seedCategories(strapi) {
  try {
    console.log("Category seeding started...");

    const filePath = path.join(process.cwd(), "subCategories1.json");

    if (!fs.existsSync(filePath)) {
      throw new Error(`Seed file not found: ${filePath}`);
    }

    const categories = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    let createdCount = 0;

    async function createCategory(category, parentId = null) {
      const existing = await strapi.documents("api::category.category").findFirst({
        filters: { slug: category.slug },
      });

      const createdCategory =
        existing ||
        (await strapi.entityService.create("api::category.category", {
          data: {
            name: category.name,
            slug: category.slug,
            isActive: category.isActive,
            sortOrder: category.sortOrder,
            category: parentId || null,
          },
        }));

      if (!existing) {
        createdCount++;
        console.log(`Created: ${category.name}`);
      } else {
        console.log(`Exists: ${category.name}`);
      }

      if (category.categories?.length) {
        for (const subCategory of category.categories) {
          await createCategory(subCategory, createdCategory.id);
        }
      }
    }

    for (const category of categories) {
      await createCategory(category);
    }

    console.log("Category seeding completed");
    console.log(`Total Created: ${createdCount}`);
  } catch (error) {
    console.error("Category seeding failed:", error);
    throw error;
  }
}

module.exports = async ({ strapi }) => {
  await seedCategories(strapi);
};

module.exports.seedCategories = seedCategories;

async function runFromCli() {
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();

  try {
    await seedCategories(app);
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
