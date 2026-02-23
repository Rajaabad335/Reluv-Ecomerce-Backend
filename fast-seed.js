const axios = require("axios");
const slugify = require("slugify");

// ============================
// CONFIG
// ============================
const STRAPI_URL = process.env.STRAPI_URL || "http://localhost:1337";
const API_TOKEN = "3b679467cc5bc1b4c9d5845d170b82b58dfdd8272e7326ad2daebe709790cedd9f68ac191b2ae9b80f39fd1fdd004a0d17a14b0eceda2e265da36b999d982bf3ee8afe91dd8b8843c142f79e254a225a785e3a6e4e69f458dff5d54bcff715c73fbb269523026be0382d012ff4252532cabf477a2bae9d7c303e64c7bdc7ff36";

// Import seed data
const seedConfig = require("./seed-data/category-attributes.seed.json");
const { subCategories } = require("./subCatagories.js");

// ============================
// AXIOS SETUP
// ============================
const api = axios.create({
  baseURL: STRAPI_URL,
  headers: {
    Authorization: "Bearer " + API_TOKEN,
    "Content-Type": "application/json",
  },
  timeout: 60000,
});

function makeSlug(...parts) {
  return slugify(parts.join("-"), { lower: true, strict: true });
}

function normalize(value) {
  return String(value).trim().toLowerCase();
}

// ============================
// FETCH HELPERS - Simplified
// ============================
async function fetchCategories() {
  try {
    const res = await api.get("/api/categories", {
      params: { "pagination[pageSize]": 500 }
    });
    return res.data.data || [];
  } catch (err) {
    console.log("Error fetching categories: " + err.message);
    if (err.response) {
      console.log("Status: " + err.response.status);
      console.log("Data: " + JSON.stringify(err.response.data));
    }
    return [];
  }
}

async function fetchExistingAttributes() {
  try {
    const res = await api.get("/api/category-attributes", {
      params: { "pagination[pageSize]": 500, "populate": "category" }
    });
    return res.data.data || [];
  } catch (err) {
    console.log("Error fetching attributes: " + err.message);
    return [];
  }
}

// ============================
// FAST SEED
// ============================
async function fastSeed() {
  console.log("\n🚀 Fast Seeding Category Attributes...");
  console.log("📡 Strapi URL: " + STRAPI_URL + "\n");
  
  // Step 1: Fetch categories
  console.log("📦 Step 1: Fetching categories...");
  const categories = await fetchCategories();
  console.log("   Found " + categories.length + " categories");
  
  if (categories.length === 0) {
    console.log("❌ No categories found. Please seed categories first.");
    return;
  }
  
  // Build category map
  const categoryMap = {};
  categories.forEach(function(cat) {
    const attrs = cat.attributes || cat;
    const slug = attrs.slug;
    const id = cat.id;
    if (slug && id) categoryMap[slug] = { id: id, name: attrs.name };
  });
  
  // Step 2: Fetch existing attributes
  console.log("\n📦 Step 2: Fetching existing attributes...");
  const existingAttrs = await fetchExistingAttributes();
  console.log("   Found " + existingAttrs.length + " existing attributes");
  
  // Build existing attribute map by category
  const existingByCategory = {};
  existingAttrs.forEach(function(attr) {
    const catId = attr.attributes?.category?.data?.id;
    if (!catId) return;
    if (!existingByCategory[catId]) existingByCategory[catId] = [];
    existingByCategory[catId].push(attr);
  });
  
  // Step 3: Build targets
  console.log("\n📦 Step 3: Building attribute targets...");
  const targets = [];
  for (let i = 0; i < subCategories.length; i++) {
    const top = subCategories[i];
    const topName = String(top.label || "").trim();
    const children = Array.isArray(top.children) ? top.children : [];
    
    for (let j = 0; j < children.length; j++) {
      const child = children[j];
      const secondName = String(child.label || "").trim();
      if (!secondName || secondName === "ALL") continue;
      
      const slug = makeSlug(secondName, topName);
      targets.push({
        key: topName + " > " + secondName,
        categorySlug: slug,
        items: Array.isArray(child.items) ? child.items : [],
      });
    }
  }
  console.log("   Built " + targets.length + " targets");
  
  // Define attribute templates
  const globalDefs = seedConfig.globalAttributes || [];
  
  function getDefinitions(key, target) {
    const specificDefs = seedConfig.categorySpecificAttributes[key] || [];
    const defs = [];
    
    // Add global attributes
    for (let k = 0; k < globalDefs.length; k++) {
      const def = globalDefs[k];
      const opts = Array.isArray(def.options) ? def.options.map(function(v) { return String(v).trim(); }).filter(Boolean) : [];
      defs.push({
        name: def.name,
        type: def.type || "string",
        isRequired: Boolean(def.isRequired),
        code: def.code || makeSlug(def.name),
        displayType: def.displayType || (def.type === "enum" ? "list" : "text"),
        options: opts
      });
    }
    
    // Add category-specific attributes
    for (let k = 0; k < specificDefs.length; k++) {
      const def = specificDefs[k];
      let opts = [];
      if (Array.isArray(def.options)) {
        opts = def.options.map(function(v) { return String(v).trim(); }).filter(Boolean);
      } else if (def.optionsSource === "level3") {
        opts = target.items.map(function(v) { return String(v).trim(); }).filter(Boolean);
      }
      
      defs.push({
        name: def.name,
        type: def.type || "string",
        isRequired: Boolean(def.isRequired),
        code: def.code || makeSlug(def.name),
        displayType: def.displayType || (def.type === "enum" ? "list" : "text"),
        options: opts
      });
    }
    
    return defs;
  }
  
  // Step 4: Create attributes and options
  console.log("\n📦 Step 4: Creating attributes and options...");
  let attrsCreated = 0;
  let optionsCreated = 0;
  let skipped = 0;
  
  for (let t = 0; t < targets.length; t++) {
    const target = targets[t];
    const category = categoryMap[target.categorySlug];
    if (!category) {
      skipped++;
      continue;
    }
    
    const categoryId = category.id;
    const existingForCat = existingByCategory[categoryId] || [];
    const existingNames = new Set();
    for (let e = 0; e < existingForCat.length; e++) {
      existingNames.add(normalize(existingForCat[e].attributes.name));
    }
    
    const defs = getDefinitions(target.key, target);
    
    for (let d = 0; d < defs.length; d++) {
      const def = defs[d];
      if (existingNames.has(normalize(def.name))) {
        skipped++;
        continue;
      }
      
      try {
        // Create attribute
        const attrRes = await api.post("/api/category-attributes", {
          data: {
            name: def.name,
            type: def.type,
            isRequired: def.isRequired,
            code: def.code,
            displayType: def.displayType,
            selectionType: "single",
            category: { id: categoryId },
          }
        });
        
        const attrId = attrRes.data.data.id;
        attrsCreated++;
        
        // Publish attribute
        try {
          await api.post("/api/category-attributes/" + attrId + "/publish");
        } catch(e) { /* ignore */ }
        
        // Create options
        for (let o = 0; o < def.options.length; o++) {
          try {
            await api.post("/api/category-attribute-options", {
              data: {
                value: def.options[o],
                sortOrder: o + 1,
                category_attribute: { id: attrId },
              }
            });
            optionsCreated++;
          } catch(e) { /* ignore option creation errors */ }
        }
        
      } catch(err) {
        console.log("   ❌ Failed: " + def.name + " - " + (err.response?.data?.error?.message || err.message));
      }
    }
  }
  
  // Summary
  console.log("\n" + "=".repeat(50));
  console.log("🎉 Fast Seed Complete!");
  console.log("=".repeat(50));
  console.log("Attributes created: " + attrsCreated);
  console.log("Options created: " + optionsCreated);
  console.log("Skipped (existing): " + skipped);
  console.log("");
}

fastSeed().catch(function(err) {
  console.error("❌ Error:", err.message);
  if (err.response) {
    console.log("Status:", err.response.status);
    console.log("Data:", JSON.stringify(err.response.data));
  }
  process.exit(1);
});
