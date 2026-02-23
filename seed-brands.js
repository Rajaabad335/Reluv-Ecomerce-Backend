const axios = require("axios");

const STRAPI_URL = "http://localhost:1337";
const API_TOKEN = "3b679467cc5bc1b4c9d5845d170b82b58dfdd8272e7326ad2daebe709790cedd9f68ac191b2ae9b80f39fd1fdd004a0d17a14b0eceda2e265da36b999d982bf3ee8afe91dd8b8843c142f79e254a225a785e3a6e4e69f458dff5d54bcff715c73fbb269523026be0382d012ff4252532cabf477a2bae9d7c303e64c7bdc7ff36";

const brandsData = require("./seed-data/brands.seed.json");

const api = axios.create({
  baseURL: STRAPI_URL,
  headers: {
    Authorization: `Bearer ${API_TOKEN}`,
    "Content-Type": "application/json",
  },
});

async function findCategoryByName(name) {
  const res = await api.get("/api/categories?pagination[limit]=100");
  const categories = res.data.data || [];
  return categories.find(c => c.attributes.name.toLowerCase() === name.toLowerCase());
}

async function createBrand(brand, categoryIds) {
  // Create without categories first
  const payload = {
    data: {
      name: brand.name,
      slug: brand.slug
    }
  };
  const res = await api.post("/api/brands", payload);
  const createdBrand = res.data.data;
  
  // Then update with categories if needed
  if (categoryIds.length > 0 && createdBrand && createdBrand.id) {
    await api.put("/api/brands/" + createdBrand.id, {
      data: {
        categories: categoryIds
      }
    });
  }
  
  return createdBrand;
}

async function findBrandBySlug(slug) {
  const res = await api.get("/api/brands?filters[slug][$eq]=" + slug);
  return res.data.data?.[0] || null;
}

async function seedBrands() {
  console.log("Starting Brands seeding...");
  
  const brands = brandsData.brands || [];
  console.log("Found " + brands.length + " brands to seed");
  
  let created = 0;
  let skipped = 0;
  
  for (const brand of brands) {
    try {
      // Check if brand exists
      const existing = await findBrandBySlug(brand.slug);
      if (existing) {
        console.log("Brand already exists: " + brand.name);
        skipped++;
        continue;
      }
      
      // Find category IDs
      const categoryIds = [];
      for (const catName of brand.categories || []) {
        const cat = await findCategoryByName(catName);
        if (cat) {
          categoryIds.push({ id: cat.id });
        }
      }
      
      const result = await createBrand(brand, categoryIds);
      if (result && result.id) {
        console.log("Created: " + brand.name + " (categories: " + brand.categories.join(", ") + ")");
        created++;
      } else {
        console.log("Failed to create: " + brand.name);
      }
    } catch (err) {
      console.error("Error creating brand " + brand.name + ":", err.message);
      if (err.response) {
        console.error("Response status:", err.response.status);
        console.error("Response data:", JSON.stringify(err.response.data));
      }
    }
  }
  
  console.log("\n=== Brands Seeding Complete ===");
  console.log("Created: " + created);
  console.log("Skipped: " + skipped);
  console.log("Total: " + brands.length);
}

seedBrands().catch(err => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
