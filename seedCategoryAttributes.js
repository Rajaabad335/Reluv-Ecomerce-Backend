const fs = require("fs");
const path = require("path");
require("dotenv").config();
const pg = require("pg");
const { customAlphabet } = require("nanoid");

const nanoid = customAlphabet(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  21
);

const RELATION_BATCH_SIZE = 50;

async function seedCategoryAttributes() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    console.log("Connecting to database...");
    await client.connect();
    console.log("Connected!");

    console.log("Category attribute seeding started...");

    const attrsFilePath = path.join(
      process.cwd(),
      "categoryAttributesUpdated.json"
    );
    const mappingFilePath = path.join(
      process.cwd(),
      "categoryAttributeMappingUpdated.json"
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

    // Load categories
    console.log("\nLoading all categories from DB...");
    const categoryResult = await client.query(
      `SELECT id, slug FROM categories`
    );
    const categoryBySlug = {};
    categoryResult.rows.forEach((cat) => {
      categoryBySlug[cat.slug] = cat.id;
    });
    console.log(`Total categories loaded: ${categoryResult.rows.length}`);

    // Load existing attributes
    const attrResult = await client.query(
      `SELECT id, code FROM category_attributes`
    );
    const attrByCode = {};
    attrResult.rows.forEach((attr) => {
      attrByCode[attr.code] = attr.id;
    });
    console.log(`Total existing attributes: ${attrResult.rows.length}\n`);

    // ── Patch existing rows that are missing document_id ──────────────────
    console.log("Patching any existing rows missing document_id...");

    const nullAttrRows = await client.query(
      `SELECT id FROM category_attributes WHERE document_id IS NULL`
    );
    for (const row of nullAttrRows.rows) {
      await client.query(
        `UPDATE category_attributes SET document_id = $1 WHERE id = $2`,
        [nanoid(), row.id]
      );
    }
    console.log(`  Patched ${nullAttrRows.rows.length} category_attributes rows`);

    const nullOptRows = await client.query(
      `SELECT id FROM category_attribute_options WHERE document_id IS NULL`
    );
    for (const row of nullOptRows.rows) {
      await client.query(
        `UPDATE category_attribute_options SET document_id = $1 WHERE id = $2`,
        [nanoid(), row.id]
      );
    }
    console.log(
      `  Patched ${nullOptRows.rows.length} category_attribute_options rows`
    );
    // ─────────────────────────────────────────────────────────────────────

    let attrCreated = 0;
    let attrSkipped = 0;
    let linksCreated = 0;
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

        const categoryIds = [];
        for (const slug of attrCodeToSlugs[attrCode]) {
          const catId = categoryBySlug[slug];
          if (!catId) {
            console.warn(`  ⚠  Slug not in DB: "${slug}"`);
            slugsMissing++;
          } else {
            categoryIds.push(catId);
          }
        }

        let attrId = attrByCode[attrCode];

        if (!attrId) {
          const createResult = await client.query(
            `INSERT INTO category_attributes 
             (document_id, name, code, type, display_type, selection_type, 
              is_required, placeholder, description, selection_limit, 
              created_at, updated_at, published_at, locale) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW(), NOW(), 'en')
             RETURNING id`,
            [
              nanoid(),                          
              attrDef.name,
              attrDef.code,
              attrDef.type,
              attrDef.displayType || "text",
              attrDef.selectionType || "single",
              attrDef.isRequired ?? false,
              attrDef.placeholder || null,
              attrDef.description || null,
              attrDef.selectionLimit || null,
            ]
          );
          attrId = createResult.rows[0].id;
          attrByCode[attrCode] = attrId;
          attrCreated++;
          console.log(`  ✓  Created [${attrCode}] "${attrDef.name}"`);
        } else {
          attrSkipped++;
          console.log(`  ↩  Exists [${attrCode}]`);
        }

        if (categoryIds.length > 0) {
          for (let i = 0; i < categoryIds.length; i += RELATION_BATCH_SIZE) {
            const batch = categoryIds.slice(i, i + RELATION_BATCH_SIZE);
            const values = batch
              .map((catId, idx) => `(${attrId}, ${catId}, ${idx}, 0)`)
              .join(",");

            try {
              const insertResult = await client.query(
                `INSERT INTO category_attributes_categories_lnk 
                 (category_attribute_id, category_id, category_attribute_ord, category_ord) 
                 VALUES ${values}
                 ON CONFLICT (category_attribute_id, category_id) DO NOTHING`
              );
              linksCreated += insertResult.rowCount;
            } catch (err) {
              console.warn(`  ⚠  Link insert partial error: ${err.message}`);
            }
          }
          console.log(`     └─ Linked to ${categoryIds.length} categories`);
        }

        if (attrDef.options?.length > 0) {
          for (const [idx, opt] of attrDef.options.entries()) {
            const existCheck = await client.query(
              `SELECT cao.id
               FROM category_attribute_options cao
               JOIN category_attribute_options_category_attribute_lnk lnk
                 ON lnk.category_attribute_option_id = cao.id
               WHERE lnk.category_attribute_id = $1 AND cao.value = $2`,
              [attrId, opt.value]
            );

            if (existCheck.rows.length === 0) {
              const optResult = await client.query(
                `INSERT INTO category_attribute_options 
                 (document_id, value, sort_order, created_at, updated_at, published_at, locale) 
                 VALUES ($1, $2, $3, NOW(), NOW(), NOW(), 'en')
                 RETURNING id`,
                [
                  nanoid(),
                  opt.value,
                  opt.sortOrder ?? idx,
                ]
              );
              const optId = optResult.rows[0].id;

              await client.query(
                `INSERT INTO category_attribute_options_category_attribute_lnk 
                 (category_attribute_option_id, category_attribute_id, category_attribute_option_ord)
                 VALUES ($1, $2, $3)
                 ON CONFLICT DO NOTHING`,
                [optId, attrId, idx]
              );
              optCreated++;
            } else {
              optSkipped++;
            }
          }
          console.log(`     └─ Options: ${attrDef.options.length}`);
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
    console.log(`Category links created     : ${linksCreated}`);
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
    console.error("Seed command failed:", error);
    throw error;
  } finally {
    await client.end();
  }
}

seedCategoryAttributes()
  .then(() => {
    console.log("Seed script finished successfully");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Seed script failed:", error);
    process.exit(1);
  });