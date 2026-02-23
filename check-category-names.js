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

async function checkCategories() {
  try {
    console.log("Fetching categories from Strapi...\n");
    
    // Get all categories with pagination
    const allCategories = [];
    let page = 1;
    
    while (true) {
      const res = await api.get(`/api/categories?pagination[page]=${page}&pagination[pageSize]=100`);
      const data = res.data.data;
      
      if (!data || data.length === 0) break;
      
      allCategories.push(...data);
      
      const totalPages = res.data.meta?.pagination?.pageCount || 1;
      if (page >= totalPages) break;
      
      page++;
    }
    
    console.log(`Total categories: ${allCategories.length}\n`);
    console.log("=== ALL CATEGORY NAMES AND SLUGS ===\n");
    
    // Group by parent
    const byParent = {};
    
    allCategories.forEach(c => {
      const name = c.attributes.name;
      const slug = c.attributes.slug;
      const parentId = c.attributes.category?.data?.id;
      
      if (!parentId) {
        if (!byParent["ROOT"]) byParent["ROOT"] = [];
        byParent["ROOT"].push({ name, slug });
      } else {
        const parent = allCategories.find(p => p.id === parentId);
        const parentName = parent ? parent.attributes.name : "Unknown";
        if (!byParent[parentName]) byParent[parentName] = [];
        byParent[parentName].push({ name, slug });
      }
    });
    
    // Print hierarchy
    Object.keys(byParent).forEach(key => {
      console.log(`\n--- ${key} ---`);
      byParent[key].forEach(c => {
        console.log(`  ${c.name} (${c.slug})`);
      });
    });
    
  } catch (err) {
    console.error("Error:", err.response?.data?.error?.message || err.message);
  }
}

checkCategories();
