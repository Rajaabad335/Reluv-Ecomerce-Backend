const axios = require("axios");

const STRAPI_URL = "http://localhost:1337";
const API_TOKEN = "3b679467cc5bc1b4c9d5845d170b82b58dfdd8272e7326ad2daebe709790cedd9f68ac191b2ae9b80f39fd1fdd004a0d17a14b0eceda2e265da36b999d982bf3ee8afe91dd8b8843c142f79e254a225a785e3a6e4e69f458dff5d54bcff715c73fbb269523026be0382d012ff4252532cabf477a2bae9d7c303e64c7bdc7ff36";

const api = axios.create({
  baseURL: STRAPI_URL,
  headers: {
    Authorization: "Bearer " + API_TOKEN,
    "Content-Type": "application/json",
  },
});

async function getAllCategories() {
  try {
    // Get all categories with pagination
    let page = 1;
    let pageSize = 100;
    let allCategories = [];
    let hasMore = true;

    while (hasMore) {
      const res = await api.get(`/api/categories?pagination[page]=${page}&pagination[pageSize]=${pageSize}`);
      const data = res.data.data || [];
      allCategories = [...allCategories, ...data];
      
      if (data.length < pageSize) {
        hasMore = false;
      } else {
        page++;
      }
    }
    
    return allCategories;
  } catch (err) {
    console.log("Error fetching categories: " + err.message);
    return [];
  }
}

async function main() {
  console.log("Fetching all categories from Strapi...\n");
  
  const categories = await getAllCategories();
  
  console.log(`Found ${categories.length} categories:\n`);
  
  // Group by parent to show hierarchy
  const rootCategories = categories.filter(c => !c.attributes.category);
  const childCategories = categories.filter(c => c.attributes.category);
  
  console.log("=== ROOT CATEGORIES (no parent) ===");
  rootCategories.forEach(c => {
    console.log(`- ${c.attributes.name} (id: ${c.id}, slug: ${c.attributes.slug})`);
  });
  
  console.log("\n=== LOOKING FOR KEY CATEGORIES ===");
  const keyCategories = ['Women', 'Men', 'Kids', 'Designer', 'Home', 'Clothing', 'Shoes'];
  
  keyCategories.forEach(keyCat => {
    const found = categories.find(c => c.attributes.name.toLowerCase() === keyCat.toLowerCase());
    if (found) {
      console.log(`✓ Found: "${keyCat}" -> id: ${found.id}, name: "${found.attributes.name}"`);
    } else {
      console.log(`✗ Not found: "${keyCat}"`);
    }
  });
  
  // Show sample of kids-related categories
  console.log("\n=== CATEGORIES WITH 'KIDS' IN NAME ===");
  const kidsRelated = categories.filter(c => c.attributes.name.toLowerCase().includes('kid'));
  kidsRelated.forEach(c => {
    console.log(`- ${c.attributes.name} (id: ${c.id})`);
  });
}

main().catch(err => {
  console.error("Error:", err.message);
});
