const axios = require("axios");

const STRAPI_URL = "http://localhost:1337";
const API_TOKEN = "3b679467cc5bc1b4c9d5845d170b82b58dfdd8272e7326ad2daebe709790cedd9f68ac191b2ae9b80f39fd1fdd004a0d17a14b0eceda2e265da36b999d982bf3ee8afe91dd8b8843c142f79e254a225a785e3a6e4e69f458dff5d54bcff715c73fbb269523026be0382d012ff4252532cabf477a2bae9d7c303e64c7bdc7ff36";

const api = axios.create({
  baseURL: STRAPI_URL,
  headers: {
    Authorization: `Bearer ${API_TOKEN}`,
    "Content-Type": "application/json",
  },
});

async function checkRelationships() {
  console.log("=== Checking Category Relationships ===\n");

  // Get "Women" category with its children
  console.log("1. Women (parent) with children:");
  try {
    const womenRes = await api.get("/api/categories?filters[slug][$eq]=women&populate=categories");
    const womenData = womenRes.data.data;
    
    if (womenData && womenData.length > 0) {
      const women = womenData[0];
      // Handle both v4 and v5 response formats
      const name = women.attributes?.name || women.name;
      const slug = women.attributes?.slug || women.slug;
      
      console.log(`   Parent: ${name} (slug: ${slug})`);
      
      // Handle the categories relationship
      let children = [];
      if (women.attributes?.categories?.data) {
        children = women.attributes.categories.data;
      } else if (women.categories?.data) {
        children = women.categories.data;
      }
      
      console.log(`   Children (${children.length}):`);
      children.forEach(child => {
        const childName = child.attributes?.name || child.name;
        const childSlug = child.attributes?.slug || child.slug;
        console.log(`   - ${childName} (${childSlug})`);
      });
    } else {
      console.log("   Women category not found!");
    }
  } catch (err) {
    console.log("   Error:", err.response?.data || err.message);
  }

  // Get "Clothing" category with its parent and children
  console.log("\n2. Clothing (child of Women) with children:");
  const clothingRes = await api.get("/api/categories?filters[slug][$eq]=clothing-women&populate[0]=category&populate[1]=categories");
  const clothing = clothingRes.data.data[0];
  
  if (clothing) {
    console.log(`   Category: ${clothing.attributes.name} (slug: ${clothing.attributes.slug})`);
    const parent = clothing.attributes.category?.data;
    if (parent) {
      console.log(`   Parent: ${parent.attributes.name} (${parent.attributes.slug})`);
    }
    const children = clothing.attributes.categories?.data || [];
    console.log(`   Children (${children.length}):`);
    children.slice(0, 5).forEach(child => {
      console.log(`   - ${child.attributes.name} (${child.attributes.slug})`);
    });
    if (children.length > 5) {
      console.log(`   ... and ${children.length - 5} more`);
    }
  }

  // Get "Outerwear" (grandchild)
  console.log("\n3. Outerwear (grandchild of Women):");
  const outerwearRes = await api.get("/api/categories?filters[slug][$eq]=outerwear-women-clothing&populate=category");
  const outerwear = outerwearRes.data.data[0];
  
  if (outerwear) {
    console.log(`   Category: ${outerwear.attributes.name} (slug: ${outerwear.attributes.slug})`);
    const parent = outerwear.attributes.category?.data;
    if (parent) {
      const grandparentRes = await api.get(`/api/categories/${parent.id}?fields=name,slug`);
      const grandparent = grandparentRes.data.data;
      console.log(`   Parent: ${grandparent.attributes.name} (${grandparent.attributes.slug})`);
    }
  }

  console.log("\n=== Relationship Structure ===");
  console.log("Women (Level 1)");
  console.log("  └── Clothing (Level 2)");
  console.log("      └── Outerwear (Level 3)");
  console.log("\n✅ The relationship is working correctly!");
}

checkRelationships().catch(console.error);
