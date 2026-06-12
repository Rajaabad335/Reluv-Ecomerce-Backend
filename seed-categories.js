/**
 * seed-categories.js
 *
 * Strapi v5 — bulk SQL seed for categories.
 * - Uses compound path slugs (women-clothing-outerwear) matching categoryAttributeMappingUpdated.json
 * - Stores document_id (UUID) as required by Strapi v5
 * - Single bulk INSERT per depth level — fastest possible approach
 * - Correctly links parent-child via categories_category_lnk
 *
 * Usage:
 *   node seed-categories.js
 */

require("dotenv").config();
const { Client } = require("pg");
const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("Missing DATABASE_URL environment variable.");

const FILE = path.join(__dirname, "subCatagories.json");
if (!fs.existsSync(FILE)) throw new Error(`File not found: ${FILE}`);
const data = JSON.parse(fs.readFileSync(FILE, "utf-8"));

// Group nodes by depth, carrying pathKey (unique internal key) and compoundSlug (db slug)
function groupByLevel(nodes, depth = 0, levels = [], parentPathKey = null, parentCompoundSlug = null) {
  if (!levels[depth]) levels[depth] = [];
  for (const node of nodes) {
    const pathKey      = parentPathKey      ? `${parentPathKey}>${node.slug}`      : node.slug;
    const compoundSlug = parentCompoundSlug ? `${parentCompoundSlug}-${node.slug}` : node.slug;
    levels[depth].push({ ...node, pathKey, parentPathKey, compoundSlug });
    if (node.categories?.length) {
      groupByLevel(node.categories, depth + 1, levels, pathKey, compoundSlug);
    }
  }
  return levels;
}

async function seed() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  console.log("Seeding categories via bulk SQL (Strapi v5)...");
  console.time("seed-categories");

  const now = new Date().toISOString();
  const pathKeyToId  = new Map(); // pathKey  → db integer id
  const pathKeyToDoc = new Map(); // pathKey  → document_id (UUID)
  let totalInserted  = 0;

  const levels = groupByLevel(data);

  // ── Pass 1: bulk INSERT per depth level ──────────────────────────────────
  for (let d = 0; d < levels.length; d++) {
    const level = levels[d];
    if (!level.length) continue;

    const values = [];
    const params = [];
    let idx = 1;

    for (const node of level) {
      const docId = randomUUID();
      // store docId so we can map it back after RETURNING
      node._docId = docId;
      values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
      params.push(docId, node.name, node.compoundSlug, node.isActive ?? true, node.sortOrder ?? 0, now);
    }

    const res = await client.query(
      `INSERT INTO categories (document_id, name, slug, is_active, sort_order, published_at)
       VALUES ${values.join(", ")}
       RETURNING id, document_id`,
      params
    );

    // RETURNING rows preserve INSERT order
    for (let i = 0; i < res.rows.length; i++) {
      const { id, document_id } = res.rows[i];
      pathKeyToId.set(level[i].pathKey, id);
      pathKeyToDoc.set(level[i].pathKey, document_id);
    }

    totalInserted += res.rowCount;
    console.log(`  Depth ${d}: ${res.rowCount} rows`);
  }

  // ── Pass 2: bulk INSERT parent-child links ───────────────────────────────
  const links = [];
  for (const level of levels) {
    for (const node of level) {
      if (!node.parentPathKey) continue;
      const childId  = pathKeyToId.get(node.pathKey);
      const parentId = pathKeyToId.get(node.parentPathKey);
      if (childId && parentId) {
        links.push({ childId, parentId });
      } else {
        console.warn(`  ⚠ Missing id: ${node.pathKey}`);
      }
    }
  }

  if (links.length) {
    const values = [];
    const params = [];
    let idx = 1;
    for (let i = 0; i < links.length; i++) {
      values.push(`($${idx++}, $${idx++}, $${idx++})`);
      params.push(links[i].childId, links[i].parentId, i + 1);
    }
    await client.query(
      `INSERT INTO categories_category_lnk (category_id, inv_category_id, category_ord)
       VALUES ${values.join(", ")}
       ON CONFLICT (category_id, inv_category_id) DO NOTHING`,
      params
    );
    console.log(`  Links: ${links.length}`);
  }

  await client.end();
  console.timeEnd("seed-categories");
  console.log(`\nDone — categories: ${totalInserted}, links: ${links.length}`);
}

seed().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
