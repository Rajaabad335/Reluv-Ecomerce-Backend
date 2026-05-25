const { Client } = require('pg');
const { randomBytes } = require('crypto');

const DATABASE_URL = "postgresql://neondb_owner:npg_IDMeHLiW4jY8@ep-autumn-resonance-ahcsobyh-pooler.c-3.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";

(async () => {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  // 1. Delete test/junk entries (non-material names)
  const validNames = [
    'Acrylic','Alpaca','Bamboo','Canvas','Cardboard','Cashmere','Ceramic','Chiffon',
    'Corduroy','Cotton','Denim','Down','Elastane','Faux fur','Faux leather','Felt',
    'Flannel','Fleece','Foam','Glass','Gold','Jute','Lace','Latex','Leather','Linen',
    'Merino','Mesh','Metal','Mohair','Neoprene','Nylon','Paper','Patent leather',
    'Plastic','Polyester','Porcelain','Rattan','Rubber','Satin','Sequin','Silicone',
    'Silk','Silver','Steel','Stone','Straw','Suede','Tulle','Tweed','Velour','Velvet',
    'Viscose','Wood','Wool',
  ];

  const del = await client.query(
    `DELETE FROM public.materials WHERE name NOT IN (${validNames.map((_, i) => `$${i + 1}`).join(',')})`,
    validNames
  );
  console.log(`Deleted ${del.rowCount} junk rows`);

  // 2. Fix duplicate document_ids — assign new unique ones
  const dupes = await client.query(
    `SELECT document_id, array_agg(id ORDER BY id) as ids
     FROM public.materials
     GROUP BY document_id
     HAVING COUNT(*) > 1`
  );

  for (const row of dupes.rows) {
    // Keep first id, reassign document_id for the rest
    const [_keep, ...rest] = row.ids;
    for (const id of rest) {
      const newDocId = randomBytes(12).toString('base64url').slice(0, 20);
      await client.query('UPDATE public.materials SET document_id = $1 WHERE id = $2', [newDocId, id]);
      console.log(`Fixed duplicate document_id for id=${id}`);
    }
  }

  const count = await client.query('SELECT COUNT(*) as total FROM public.materials');
  console.log('Total materials now:', count.rows[0].total);

  await client.end();
})();
