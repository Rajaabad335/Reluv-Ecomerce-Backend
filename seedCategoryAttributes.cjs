/**
 * seedCategoryAttributes.cjs
 *
 * Bulk seeds category_attributes, category_attribute_options,
 * and their link tables directly via raw SQL — no Strapi API overhead.
 *
 * Tables:
 *   category_attributes                          — attribute definitions
 *   category_attribute_options                   — attribute options
 *   category_attribute_options_category_attribute_lnk — option → attribute link
 *   category_attributes_categories_lnk           — attribute → category link
 *
 * Usage:
 *   node seedCategoryAttributes.cjs
 */

"use strict";
require("dotenv").config();

const fs   = require("fs");
const path = require("path");
const { Client }     = require("pg");
const { randomUUID } = require("crypto");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("Missing DATABASE_URL environment variable.");

const attributeDefs    = JSON.parse(fs.readFileSync(path.join(__dirname, "categoryAttributesUpdated.json"),   "utf-8"));
const slugToAttrCodes  = JSON.parse(fs.readFileSync(path.join(__dirname, "categoryAttributeMappingUpdated.json"), "utf-8"));

async function seed() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  console.log("Seeding category attributes via bulk SQL...");
  console.time("seed-attributes");

  const now = new Date().toISOString();

  // ── 1. Load existing category slugs → id map ─────────────────────────────
  const catRows = await client.query(`SELECT id, slug FROM categories`);
  const slugToId = new Map(catRows.rows.map(r => [r.slug, r.id]));
  console.log(`  Categories loaded: ${slugToId.size}`);

  // ── 2. Wipe existing attribute data cleanly ───────────────────────────────
  await client.query(`TRUNCATE category_attributes_categories_lnk,
                               category_attribute_options_category_attribute_lnk,
                               category_attribute_options,
                               category_attributes
                      RESTART IDENTITY CASCADE`);
  console.log("  Existing attribute data wiped.");

  // ── 3. Bulk insert category_attributes ───────────────────────────────────
  const attrValues  = [];
  const attrParams  = [];
  let idx = 1;

  for (const attr of attributeDefs) {
    attrValues.push(`($${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++})`);
    attrParams.push(
      randomUUID(),          // document_id
      attr.name,
      attr.code,
      attr.type,
      attr.displayType   ?? "list",
      attr.selectionType ?? "single",
      attr.isRequired    ?? false,
      attr.placeholder   ?? null,
      attr.description   ?? null,
      attr.selectionLimit ?? null
    );
  }

  const attrRes = await client.query(
    `INSERT INTO category_attributes
       (document_id, name, code, type, display_type, selection_type, is_required, placeholder, description, selection_limit)
     VALUES ${attrValues.join(",")}
     RETURNING id, code`,
    attrParams
  );

  // code → db id
  const codeToAttrId = new Map(attrRes.rows.map(r => [r.code, r.id]));
  console.log(`  Attributes inserted: ${attrRes.rowCount}`);

  // ── 4. Bulk insert category_attribute_options ────────────────────────────
  const optRows    = []; // { attrCode, optionId } for link table
  const optValues  = [];
  const optParams  = [];
  idx = 1;

  for (const attr of attributeDefs) {
    for (const opt of (attr.options || [])) {
      optValues.push(`($${idx++},$${idx++},$${idx++},$${idx++})`);
      optParams.push(randomUUID(), opt.value, opt.sortOrder ?? 0, now);
      optRows.push({ attrCode: attr.code });
    }
  }

  let optionIds = [];
  if (optValues.length) {
    const optRes = await client.query(
      `INSERT INTO category_attribute_options (document_id, value, sort_order, published_at)
       VALUES ${optValues.join(",")}
       RETURNING id`,
      optParams
    );
    optionIds = optRes.rows.map(r => r.id);
    console.log(`  Options inserted: ${optRes.rowCount}`);
  }

  // ── 5. Bulk insert option → attribute links ───────────────────────────────
  if (optionIds.length) {
    const lnkValues = [];
    const lnkParams = [];
    idx = 1;
    for (let i = 0; i < optionIds.length; i++) {
      const attrId = codeToAttrId.get(optRows[i].attrCode);
      lnkValues.push(`($${idx++},$${idx++},$${idx++})`);
      lnkParams.push(optionIds[i], attrId, i + 1);
    }
    await client.query(
      `INSERT INTO category_attribute_options_category_attribute_lnk
         (category_attribute_option_id, category_attribute_id, category_attribute_option_ord)
       VALUES ${lnkValues.join(",")}`,
      lnkParams
    );
    console.log(`  Option→Attribute links inserted: ${optionIds.length}`);
  }

  // ── 6. Bulk insert attribute → category links ────────────────────────────
  // Build: for each category slug in the mapping, get attribute ids
  const attrCatLinks = [];
  let missingCats    = 0;
  let missingAttrs   = 0;

  for (const [slug, codes] of Object.entries(slugToAttrCodes)) {
    const catId = slugToId.get(slug);
    if (!catId) { missingCats++; continue; }

    for (const code of codes) {
      const attrId = codeToAttrId.get(code);
      if (!attrId) { missingAttrs++; continue; }
      attrCatLinks.push({ attrId, catId });
    }
  }

  if (attrCatLinks.length) {
    const lnkValues = [];
    const lnkParams = [];
    idx = 1;
    for (let i = 0; i < attrCatLinks.length; i++) {
      lnkValues.push(`($${idx++},$${idx++},$${idx++})`);
      lnkParams.push(attrCatLinks[i].attrId, attrCatLinks[i].catId, i + 1);
    }
    await client.query(
      `INSERT INTO category_attributes_categories_lnk
         (category_attribute_id, category_id, category_ord)
       VALUES ${lnkValues.join(",")}
       ON CONFLICT DO NOTHING`,
      lnkParams
    );
    console.log(`  Attribute→Category links inserted: ${attrCatLinks.length}`);
  }

  if (missingCats  > 0) console.warn(`  ⚠ Missing category slugs : ${missingCats}`);
  if (missingAttrs > 0) console.warn(`  ⚠ Missing attribute codes: ${missingAttrs}`);

  await client.end();
  console.timeEnd("seed-attributes");
  console.log("\nDone ✓");
}

seed().catch(err => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
