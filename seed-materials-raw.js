const { Client } = require('pg');
const slugify = require('slugify');
const { randomBytes } = require('crypto');

function makeDocumentId() {
  return randomBytes(12).toString('base64url').slice(0, 20);
}

// ============================
// RAW DB SEED (Postgres)
// ============================
// This bypasses Strapi HTTP entirely.
// It inserts into Strapi's underlying table for the Material content-type.
//
// NOTE: You MUST run this only if DATABASE_CLIENT=postgres and DATABASE_URL is set.

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://neondb_owner:npg_IDMeHLiW4jY8@ep-autumn-resonance-ahcsobyh-pooler.c-3.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL env var.');
  process.exit(1);
}

function makeSlug(name) {
  return slugify(String(name), { lower: true, strict: true });
}

// from user payload
const materials = [
  'Acrylic',
  'Alpaca',
  'Bamboo',
  'Canvas',
  'Cardboard',
  'Cashmere',
  'Ceramic',
  'Chiffon',
  'Corduroy',
  'Cotton',
  'Denim',
  'Down',
  'Elastane',
  'Faux fur',
  'Faux leather',
  'Felt',
  'Flannel',
  'Fleece',
  'Foam',
  'Glass',
  'Gold',
  'Jute',
  'Lace',
  'Latex',
  'Leather',
  'Linen',
  'Merino',
  'Mesh',
  'Metal',
  'Mohair',
  'Neoprene',
  'Nylon',
  'Paper',
  'Patent leather',
  'Plastic',
  'Polyester',
  'Porcelain',
  'Rattan',
  'Rubber',
  'Satin',
  'Sequin',
  'Silicone',
  'Silk',
  'Silver',
  'Steel',
  'Stone',
  'Straw',
  'Suede',
  'Tulle',
  'Tweed',
  'Velour',
  'Velvet',
  'Viscose',
  'Wood',
  'Wool',
];

// Discovered table name from information_schema (your DB): public.materials
const TABLE = 'public.materials';


(async () => {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  const now = new Date();

  for (const name of materials) {
    const slug = makeSlug(name);
    const document_id = makeDocumentId();
    await client.query(
      `INSERT INTO ${TABLE} (document_id, name, slug, created_at, updated_at, published_at)
       SELECT $1, $2::varchar, $3, $4, $5, $6
       WHERE NOT EXISTS (SELECT 1 FROM ${TABLE} WHERE name = $2::varchar)`,
      [document_id, name, slug, now, now, now]
    );
    console.log(name)
  }

  console.log('✅ Seed complete.');
  await client.end();
})();

