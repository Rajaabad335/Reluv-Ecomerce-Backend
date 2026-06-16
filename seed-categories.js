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
  const pathKeyToId = new Map();
  let totalInserted = 0;

  const levels = groupByLevel(data);
  console.log(`Tree: ${levels.length} depth levels, ${levels.flat().length} total nodes`);

  // ── Pass 1: INSERT categories ─────────────────────────────────────────────
  // No ON CONFLICT — instead we DELETE existing rows by slug first (idempotent),
  // then do a clean INSERT. This avoids needing a unique constraint.
  for (let d = 0; d < levels.length; d++) {
    const level = levels[d];
    if (!level.length) continue;

    for (const node of level) {
      node._docId = randomUUID();
    }

    // Delete any existing rows with these slugs so we can re-insert cleanly
    const slugs = level.map(n => n.compoundSlug);
    const delPlaceholders = slugs.map((_, i) => `$${i + 1}`).join(", ");
    await client.query(
      `DELETE FROM categories WHERE slug IN (${delPlaceholders})`,
      slugs
    );

    const valueClauses = [];
    const params = [];
    let idx = 1;

    for (const node of level) {
      valueClauses.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
      params.push(
        node._docId,
        node.name,
        node.compoundSlug,
        node.isActive ?? true,
        node.sortOrder ?? 0,
        now
      );
    }

    const res = await client.query(
      `INSERT INTO categories (document_id, name, slug, is_active, sort_order, published_at)
       VALUES ${valueClauses.join(", ")}
       RETURNING id, document_id`,
      params
    );

    // Correlate by document_id — NOT by array index (order not guaranteed)
    const docToId = new Map(res.rows.map(r => [r.document_id, r.id]));

    let mapped = 0;
    for (const node of level) {
      const dbId = docToId.get(node._docId);
      if (dbId == null) {
        console.warn(`  ⚠ No RETURNING row for "${node.compoundSlug}"`);
        continue;
      }
      pathKeyToId.set(node.pathKey, dbId);
      mapped++;
    }

    totalInserted += res.rowCount;
    console.log(`  Depth ${d}: ${res.rowCount} inserted, ${mapped} mapped`);
  }

  // ── Pass 2: INSERT parent-child links ─────────────────────────────────────
  const siblingCounter = new Map();
  const links = [];

  for (const level of levels) {
    for (const node of level) {
      if (!node.parentPathKey) continue;
      const childId  = pathKeyToId.get(node.pathKey);
      const parentId = pathKeyToId.get(node.parentPathKey);
      if (!childId)  { console.warn(`  ⚠ Missing childId:  ${node.pathKey}`);  continue; }
      if (!parentId) { console.warn(`  ⚠ Missing parentId: ${node.parentPathKey}`); continue; }

      const ord = (siblingCounter.get(parentId) ?? 0) + 1;
      siblingCounter.set(parentId, ord);
      links.push({ childId, parentId, ord });
    }
  }

  console.log(`  Total links: ${links.length}`);

  if (links.length) {
    // Clean out any old links for these child ids
    const allChildIds = [...new Set(links.map(l => l.childId))];
    const CHUNK = 500;

    for (let i = 0; i < allChildIds.length; i += CHUNK) {
      const chunk = allChildIds.slice(i, i + CHUNK);
      const ph = chunk.map((_, j) => `$${j + 1}`).join(", ");
      await client.query(
        `DELETE FROM categories_category_lnk WHERE category_id IN (${ph})`,
        chunk
      );
    }

    // Insert links in chunks
    for (let i = 0; i < links.length; i += CHUNK) {
      const chunk = links.slice(i, i + CHUNK);
      const valueClauses = [];
      const params = [];
      let idx = 1;

      for (const lnk of chunk) {
        valueClauses.push(`($${idx++}, $${idx++}, $${idx++})`);
        params.push(lnk.childId, lnk.parentId, lnk.ord);
      }

      await client.query(
        `INSERT INTO categories_category_lnk (category_id, inv_category_id, category_ord)
         VALUES ${valueClauses.join(", ")}`,
        params
      );
    }

    console.log(`  Links inserted: ${links.length}`);
  }

  await client.end();
  console.timeEnd("seed-categories");
  console.log(`\nDone — categories: ${totalInserted}, links: ${links.length}`);
}

seed().catch((err) => {
  console.error("Seed failed:", err.message);
  console.error(err.stack);
  process.exit(1);
});