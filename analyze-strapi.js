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

async function fetchAllCategories() {
  const categories = [];
  let page = 1;
  const pageSize = 100;
  
  while (true) {
    const res = await api.get("/api/categories", {
      params: {
        "pagination[page]": page,
        "pagination[pageSize]": pageSize,
        "populate": "*"
      }
    });
    
    const data = res.data.data;
    if (!data || data.length === 0) break;
    
    categories.push(...data);
    
    const pagination = res.data.meta?.pagination;
    if (!pagination || page >= pagination.pageCount) break;
    page++;
  }
  
  return categories;
}

async function fetchAllCategoryAttributes() {
  const attributes = [];
  let page = 1;
  const pageSize = 100;
  
  while (true) {
    const res = await api.get("/api/category-attributes", {
      params: {
        "pagination[page]": page,
        "pagination[pageSize]": pageSize,
        "populate": "category,category_attribute_options"
      }
    });
    
    const data = res.data.data;
    if (!data || data.length === 0) break;
    
    attributes.push(...data);
    
    const pagination = res.data.meta?.pagination;
    if (!pagination || page >= pagination.pageCount) break;
    page++;
  }
  
  return attributes;
}

async function fetchAllBrands() {
  const res = await api.get("/api/brands", {
    params: { "pagination[pageSize]": 100 }
  });
  return res.data.data || [];
}

async function fetchAllSizes() {
  const res = await api.get("/api/sizes", {
    params: { "pagination[pageSize]": 100, "populate": "category" }
  });
  return res.data.data || [];
}

async function analyze() {
  console.log("=== Analyzing Strapi Backend ===\n");
  
  // Fetch all categories
  console.log("Fetching categories...");
  const categories = await fetchAllCategories();
  console.log(`Total categories: ${categories.length}`);
  
  // Group categories by level
  const level1 = categories.filter(c => !c.attributes.category);
  const level2 = categories.filter(c => c.attributes.category && c.attributes.categories?.data?.length === 0);
  const level3 = categories.filter(c => c.attributes.categories?.data?.length > 0);
  
  console.log(`Level 1 (Parent): ${level1.length}`);
  console.log(`Level 2 (Child): ${level2.length}`);
  console.log(`Level 3 (Sub-child): ${level3.length}`);
  
  // Show Level 1 categories
  console.log("\n=== Level 1 Categories ===");
  level1.forEach(c => console.log(`- ${c.attributes.name} (ID: ${c.id}, Slug: ${c.attributes.slug})`));
  
  // Show Level 2 categories with their parent
  console.log("\n=== Level 2 Categories ===");
  level2.forEach(c => {
    const parent = c.attributes.category?.data;
    const parentName = parent ? parent.attributes.name : "None";
    console.log(`- ${c.attributes.name} (ID: ${c.id}) -> Parent: ${parentName}`);
  });
  
  // Fetch all category attributes
  console.log("\nFetching category attributes...");
  const attributes = await fetchAllCategoryAttributes();
  console.log(`Total category attributes: ${attributes.length}`);
  
  // Group attributes by category
  const attrsByCategory = {};
  attributes.forEach(attr => {
    const catId = attr.attributes.category?.data?.id;
    if (!catId) return;
    if (!attrsByCategory[catId]) attrsByCategory[catId] = [];
    attrsByCategory[catId].push(attr);
  });
  
  console.log("\n=== Attributes per Category ===");
  Object.keys(attrsByCategory).forEach(catId => {
    const cat = categories.find(c => c.id === parseInt(catId));
    const catName = cat ? cat.attributes.name : `ID: ${catId}`;
    console.log(`\n${catName} (${attrsByCategory[catId].length} attributes):`);
    attrsByCategory[catId].forEach(attr => {
      const options = attr.attributes.category_attribute_options?.data || [];
      console.log(`  - ${attr.attributes.name} (${attr.attributes.type}) - ${options.length} options`);
    });
  });
  
  // Check brands
  console.log("\n=== Brands ===");
  const brands = await fetchAllBrands();
  console.log(`Total brands: ${brands.length}`);
  brands.slice(0, 10).forEach(b => console.log(`- ${b.attributes.name}`));
  if (brands.length > 10) console.log(`... and ${brands.length - 10} more`);
  
  // Check sizes
  console.log("\n=== Sizes ===");
  const sizes = await fetchAllSizes();
  console.log(`Total sizes: ${sizes.length}`);
  sizes.slice(0, 10).forEach(s => {
    const catName = s.attributes.category?.data?.attributes.name || "No category";
    console.log(`- ${s.attributes.name} -> ${catName}`);
  });
  if (sizes.length > 10) console.log(`... and ${sizes.length - 10} more`);
  
  // Summary
  console.log("\n=== Summary ===");
  console.log(`Total categories: ${categories.length}`);
  console.log(`Total attributes: ${attributes.length}`);
  console.log(`Total brands: ${brands.length}`);
  console.log(`Total sizes: ${sizes.length}`);
  
  // Export category structure for seeding
  console.log("\n=== Category Structure Export ===");
  const categoryStructure = {};
  level1.forEach(l1 => {
    const l1Name = l1.attributes.name;
    const l1Id = l1.id;
    
    const children = level2.filter(c => c.attributes.category?.data?.id === l1Id);
    const childData = children.map(l2 => {
      const l2Id = l2.id;
      const subChildren = level3.filter(c => c.attributes.categories?.data?.some(cat => cat.id === l2Id));
      return {
        name: l2.attributes.name,
        id: l2Id,
        items: subChildren.map(s => s.attributes.name)
      };
    });
    
    categoryStructure[l1Name] = childData;
  });
  
  console.log(JSON.stringify(categoryStructure, null, 2));
}

analyze().catch(err => {
  console.error("Error:", err.response?.data || err.message || err);
});
