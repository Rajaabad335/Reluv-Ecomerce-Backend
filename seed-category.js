const axios = require("axios");
const slugify = require("slugify");

// ============================
// CONFIG
// ============================
const STRAPI_URL = "http://localhost:1337";
const API_TOKEN = "3b679467cc5bc1b4c9d5845d170b82b58dfdd8272e7326ad2daebe709790cedd9f68ac191b2ae9b80f39fd1fdd004a0d17a14b0eceda2e265da36b999d982bf3ee8afe91dd8b8843c142f79e254a225a785e3a6e4e69f458dff5d54bcff715c73fbb269523026be0382d012ff4252532cabf477a2bae9d7c303e64c7bdc7ff36";

// Your array: paste it directly here OR import it
const { subCategories } = require("./subCatagories.js");

// ============================
// HELPERS
// ============================
const api = axios.create({
  baseURL: STRAPI_URL,
  headers: {
    Authorization: `Bearer ${API_TOKEN}`,
    "Content-Type": "application/json",
  },
});

function makeSlug(...parts) {
  return slugify(parts.join("-"), { lower: true, strict: true });
}

// Create a single category
async function createCategory(categoryData) {
  const payload = {
    data: categoryData
  };
  
  const res = await api.post("/api/categories", payload);
  return res.data.data;
}

// Find existing category by slug
async function findCategoryBySlug(slug) {
  const res = await api.get(`/api/categories?filters[slug][$eq]=${slug}`);
  return res.data?.data?.[0] || null;
}

// Create category if not exists
async function createIfNotExists(categoryData) {
  const existing = await findCategoryBySlug(categoryData.slug);
  if (existing) {
    console.log(`⚠️ Already exists: ${categoryData.slug}`);
    return existing;
  }

  try {
    const created = await createCategory(categoryData);
    console.log(`✅ Created: ${categoryData.slug}`);
    return created;
  } catch (err) {
    console.error(`❌ Error creating ${categoryData.slug}:`, err.response?.data?.error?.message || err.message);
    return null;
  }
}

// ============================
// MAIN SEED
// ============================
async function seed() {
  console.log("🚀 Seeding categories...");
  console.time("Seeding completed in");

  // ------------------------
  // LEVEL 1 (Women, Men, Designer, etc.)
  // ------------------------
  console.log("📦 Step 1: Creating Level 1 categories...");

  for (let i = 0; i < subCategories.length; i++) {
    const level1 = subCategories[i];
    const level1Name = level1.label.trim();
    const level1Slug = makeSlug(level1Name);

    const parentCategory = await createIfNotExists({
      name: level1Name,
      slug: level1Slug,
      isActive: true,
      sortOrder: i + 1
    });

    if (!parentCategory) continue;
    
    const level1Id = parentCategory.id;

    // ------------------------
    // LEVEL 2 (Clothing, Shoes, etc.)
    // ------------------------
    const children = level1.children || [];
    const realChildren = children.filter((c) => c.label !== "ALL");

    for (let j = 0; j < realChildren.length; j++) {
      const level2 = realChildren[j];
      const level2Name = level2.label.trim();
      const level2Slug = makeSlug(level2Name, level1Name);

      const childCategory = await createIfNotExists({
        name: level2Name,
        slug: level2Slug,
        isActive: true,
        sortOrder: j + 1,
        category: { id: level1Id }
      });

      if (!childCategory) continue;
      
      const level2Id = childCategory.id;

      // ------------------------
      // LEVEL 3 (items array)
      // ------------------------
      const items = level2.items || [];

      for (let k = 0; k < items.length; k++) {
        const level3Name = items[k].trim();
        const level3Slug = makeSlug(level3Name, level1Name, level2Name);

        await createIfNotExists({
          name: level3Name,
          slug: level3Slug,
          isActive: true,
          sortOrder: k + 1,
          category: { id: level2Id }
        });
      }
    }
  }

  console.timeEnd("Seeding completed in");
  console.log("🎉 Done! All categories seeded.");
}


seed().catch((err) => {
  console.error("❌ Seed failed:", err?.response?.data || err.message);
});
