const fs = require("fs");
const path = require("path");
const { compileStrapi, createStrapi } = require("@strapi/core");

const ATTRIBUTE_UID = "api::category-attribute.category-attribute";
const CATEGORY_UID = "api::category.category";
const OPTION_UID = "api::category-attribute-option.category-attribute-option";
const LINK_TABLE = "category_attributes_categories_lnk";
const PAGE_SIZE = 500;
const INSERT_BATCH_SIZE = 1000;
const OPTION_BATCH_SIZE = 25;

const chunk = (items, size) => {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
};

const readJson = (fileName) => {
  const filePath = path.join(process.cwd(), fileName);
  if (!fs.existsSync(filePath)) throw new Error(`Seed file not found: ${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
};

async function findManyDocuments(strapi, uid, params = {}) {
  const rows = [];
  let start = 0;

  while (true) {
    const batch = await strapi.documents(uid).findMany({
      ...params,
      limit: PAGE_SIZE,
      start,
    });

    if (!batch?.length) break;
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    start += PAGE_SIZE;
  }

  return rows;
}

async function getLinkColumns(strapi) {
  const hasTable = await strapi.db.connection.schema.hasTable(LINK_TABLE);
  if (!hasTable) {
    throw new Error(
      `Missing ${LINK_TABLE}. Run Strapi migrations first so the many-to-many relation table exists.`
    );
  }

  const columns = await strapi.db.connection(LINK_TABLE).columnInfo();
  return new Set(Object.keys(columns));
}

async function insertCategoryLinks(strapi, linkColumns, attributeId, categoryIds) {
  if (!categoryIds.length) return 0;

  const existingRows = await strapi.db
    .connection(LINK_TABLE)
    .select("category_id")
    .where("category_attribute_id", attributeId)
    .whereIn("category_id", categoryIds);

  const existingIds = new Set(existingRows.map((row) => Number(row.category_id)));
  const missingIds = categoryIds.filter((id) => !existingIds.has(Number(id)));
  if (!missingIds.length) return 0;

  let inserted = 0;
  for (const batch of chunk(missingIds, INSERT_BATCH_SIZE)) {
    const rows = batch.map((categoryId, index) => {
      const row = {
        category_attribute_id: attributeId,
        category_id: categoryId,
      };

      if (linkColumns.has("category_attribute_ord")) row.category_attribute_ord = index;
      if (linkColumns.has("category_ord")) row.category_ord = 0;

      return row;
    });

    await strapi.db.connection(LINK_TABLE).insert(rows);
    inserted += rows.length;
  }

  return inserted;
}

async function createMissingOptions(strapi, attributeDocumentId, existingValues, options = []) {
  const missing = options.filter((opt) => !existingValues.has(String(opt.value)));
  let created = 0;

  for (const batch of chunk(missing, OPTION_BATCH_SIZE)) {
    await Promise.all(
      batch.map((opt) =>
        strapi.documents(OPTION_UID).create({
          data: {
            value: opt.value,
            sortOrder: opt.sortOrder,
            category_attribute: attributeDocumentId,
          },
        })
      )
    );
    created += batch.length;
  }

  return { created, skipped: options.length - missing.length };
}

async function seedCategoryAttributes(strapi) {
  console.log("Category attribute seeding started...");

  const attributeDefs = readJson("categoryAttributes.json");
  const slugToAttrCodes = readJson("categoryAttributeMapping.json");
  const linkColumns = await getLinkColumns(strapi);

  const attrDefByCode = new Map(attributeDefs.map((attr) => [attr.code, attr]));
  const attrCodeToSlugs = new Map();

  for (const [slug, codes] of Object.entries(slugToAttrCodes)) {
    for (const code of codes) {
      if (!attrCodeToSlugs.has(code)) attrCodeToSlugs.set(code, []);
      attrCodeToSlugs.get(code).push(slug);
    }
  }

  console.log(`Unique attribute codes : ${attrCodeToSlugs.size}`);
  console.log(
    `Total category-attr pairs : ${[...attrCodeToSlugs.values()].reduce(
      (sum, slugs) => sum + slugs.length,
      0
    )}`
  );

  const categories = await findManyDocuments(strapi, CATEGORY_UID, {
    fields: ["slug"],
  });
  const categoryBySlug = new Map(categories.map((cat) => [cat.slug, cat]));
  console.log(`Categories loaded       : ${categoryBySlug.size}`);

  const existingAttributes = await findManyDocuments(strapi, ATTRIBUTE_UID, {
    fields: ["code"],
    populate: {
      categories: { fields: ["slug"] },
      category_attribute_options: { fields: ["value"] },
    },
  });
  const attrByCode = new Map(existingAttributes.map((attr) => [attr.code, attr]));
  console.log(`Existing attributes     : ${attrByCode.size}`);

  let attrCreated = 0;
  let attrSkipped = 0;
  let linksCreated = 0;
  let optCreated = 0;
  let optSkipped = 0;
  let slugsMissing = 0;
  const errors = [];

  for (const [attrCode, slugs] of attrCodeToSlugs) {
    try {
      const attrDef = attrDefByCode.get(attrCode);
      if (!attrDef) {
        console.warn(`No definition for code "${attrCode}" - skipping`);
        continue;
      }

      const categoryIds = [
        ...new Set(
          slugs
            .map((slug) => {
              const category = categoryBySlug.get(slug);
              if (!category) slugsMissing++;
              return category?.id;
            })
            .filter(Boolean)
        ),
      ];

      let attr = attrByCode.get(attrCode);
      if (!attr) {
        attr = await strapi.documents(ATTRIBUTE_UID).create({
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
        attrByCode.set(attrCode, attr);
        attrCreated++;
      } else {
        attrSkipped++;
      }

      const linked = await insertCategoryLinks(strapi, linkColumns, attr.id, categoryIds);
      linksCreated += linked;

      const existingOptionValues = new Set(
        (attr.category_attribute_options || []).map((opt) => String(opt.value))
      );
      const optionStats = await createMissingOptions(
        strapi,
        attr.documentId,
        existingOptionValues,
        attrDef.options || []
      );
      optCreated += optionStats.created;
      optSkipped += optionStats.skipped;

      console.log(
        `[${attrCode}] ${attrCreated + attrSkipped}/${attrCodeToSlugs.size} - linked ${linked}, options ${optionStats.created} new`
      );
    } catch (error) {
      console.error(`ERROR on [${attrCode}]: ${error.message}`);
      errors.push({ attrCode, error: error.message });
    }
  }

  console.log("\n========== Seeding Summary ==========");
  console.log(`Unique attributes total    : ${attrCodeToSlugs.size}`);
  console.log(`Attributes created         : ${attrCreated}`);
  console.log(`Attributes already existed : ${attrSkipped}`);
  console.log(`Category links created     : ${linksCreated}`);
  console.log(`Options created            : ${optCreated}`);
  console.log(`Options already existed    : ${optSkipped}`);
  console.log(`Category slugs missing     : ${slugsMissing}`);
  console.log(`Errors                     : ${errors.length}`);
  if (errors.length > 0) {
    console.log("\nFailed attributes:");
    errors.forEach(({ attrCode, error }) => console.log(`  [${attrCode}] ${error}`));
  }
  console.log("=====================================");
  console.log("Category attribute seeding completed.");
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
