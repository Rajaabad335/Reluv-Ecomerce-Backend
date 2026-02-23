const axios = require("axios");
const slugify = require("slugify");

// ============================
// CONFIG
// ============================
const STRAPI_URL = "http://localhost:1337";
const API_TOKEN = "3b679467cc5bc1b4c9d5845d170b82b58dfdd8272e7326ad2daebe709790cedd9f68ac191b2ae9b80f39fd1fdd004a0d17a14b0eceda2e265da36b999d982bf3ee8afe91dd8b8843c142f79e254a225a785e3a6e4e69f458dff5d54bcff715c73fbb269523026be0382d012ff4252532cabf477a2bae9d7c303e64c7bdc7ff36";

const seedConfig = require("./seed-data/category-attributes.seed.json");
const { subCategories } = require("./subCatagories.js");

const api = axios.create({
  baseURL: STRAPI_URL,
  headers: {
    Authorization: `Bearer ${API_TOKEN}`,
    "Content-Type": "application/json",
  },
  timeout: 30000,
});

function makeSlug(...parts) {
  return slugify(parts.join("-"), { lower: true, strict: true });
}

function normalize(value) {
  return String(value).trim().toLowerCase();
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================
// COMPLETE SEED - All Levels
// ============================
async function completeSeed() {
  console.log("\n🚀 Complete Seeding - All Category Levels...");
  console.log(`📡 Strapi URL: ${STRAPI_URL}\n`);

  // Step 1: Fetch ALL categories with full hierarchy
  console.log("📦 Step 1: Fetching all categories...");
  const catRes = await api.get("/api/categories", { 
    params: { 
      "pagination[pageSize]": 500,
      populate: ["category", "categories"] 
    } 
  });
  const categories = catRes.data.data || [];
  console.log(`   ✅ Found ${categories.length} categories`);

  // Build category map with hierarchy
  const categoryMap = {};
  const childrenMap = {}; // parentId -> children[]
  
  categories.forEach(cat => {
    const attrs = cat.attributes || cat;
    const id = cat.id;
    const name = attrs.name;
    const slug = attrs.slug;
    const parentId = attrs.category?.data?.id;
    
    categoryMap[id] = { id, name, slug, parentId };
    
    if (parentId) {
      if (!childrenMap[parentId]) childrenMap[parentId] = [];
      childrenMap[parentId].push(id);
    }
  });

  // Identify levels
  const rootCategories = categories.filter(cat => {
    const attrs = cat.attributes || cat;
    return !attrs.category?.data?.id;
  }).map(cat => cat.id);

  console.log(`   Root categories: ${rootCategories.length}`);

  // Step 2: Fetch existing attributes
  console.log("\n📦 Step 2: Fetching existing attributes...");
  const attrRes = await api.get("/api/category-attributes", { 
    params: { "pagination[pageSize]": 1000, populate: "category" } 
  });
  const existingAttrs = attrRes.data.data || [];
  console.log(`   ✅ Found ${existingAttrs.length} existing attributes`);

  const existingByCat = {};
  existingAttrs.forEach(attr => {
    const attrs = attr.attributes || attr;
    const catId = attrs.category?.data?.id;
    if (!catId) return;
    if (!existingByCat[catId]) existingByCat[catId] = [];
    existingByCat[catId].push(attrs.name);
  });

  // Step 3: Prepare attribute definitions
  console.log("\n📦 Step 3: Preparing attribute definitions...");
  const globalDefs = seedConfig.globalAttributes || [];

  // Get all category-specific definitions keys
  const defKeys = Object.keys(seedConfig.categorySpecificAttributes || {});

  // Function to get definitions for a category
  function getDefsForCategory(key) {
    const specific = seedConfig.categorySpecificAttributes?.[key] || [];
    return [...globalDefs, ...specific];
  }

  // Step 4: Create attributes for ALL categories (root, level2, level3)
  console.log("\n📦 Step 4: Creating attributes for ALL categories...");

  const attributesToCreate = [];
  const attributeOptionsMap = {};

  // Process each root category (Women, Men, Designer, etc.)
  for (const rootId of rootCategories) {
    const rootCat = categoryMap[rootId];
    const rootName = rootCat.name;
    
    console.log(`\n   Processing root: ${rootName} (ID: ${rootId})`);
    
    // Get children of this root (Level 2)
    const level2Ids = childrenMap[rootId] || [];
    
    for (const l2Id of level2Ids) {
      const l2Cat = categoryMap[l2Id];
      const l2Name = l2Cat.name;
      const key = `${rootName} > ${l2Name}`;
      
      // Get definitions for this Level 2 category
      const defs = getDefsForCategory(key);
      const existingForL2 = existingByCat[l2Id] || [];
      const existingNamesL2 = new Set(existingForL2.map(n => normalize(n)));
      
      console.log(`      Level 2: ${l2Name} - ${defs.length} definitions, ${existingForL2.length} existing`);
      
      // Create attributes for Level 2 category
      for (const def of defs) {
        if (existingNamesL2.has(normalize(def.name))) continue;
        
        let options = [];
        if (Array.isArray(def.options)) {
          options = def.options.map(v => String(v).trim()).filter(Boolean);
        } else if (def.optionsSource === "level3") {
          // Get items from subCategories for this category
          const subCat = subCategories.find(s => s.label === rootName);
          const child = subCat?.children?.find(c => c.label === l2Name);
          options = (child?.items || []).map(v => String(v).trim()).filter(Boolean);
        }
        
        const attrData = {
          name: def.name,
          type: def.type || "string",
          isRequired: Boolean(def.isRequired),
          code: def.code || makeSlug(def.name),
          displayType: def.displayType || (def.type === "enum" ? "list" : "text"),
          selectionType: "single",
          category: l2Id
        };
        
        attributesToCreate.push(attrData);
        
        if (options.length > 0) {
          attributeOptionsMap[attrData.code + "_" + l2Id] = options;
        }
      }
      
      // Process Level 3 children of this Level 2
      const level3Ids = childrenMap[l2Id] || [];
      
      for (const l3Id of level3Ids) {
        const l3Cat = categoryMap[l3Id];
        const l3Name = l3Cat.name;
        const l3Key = `${key} > ${l3Name}`;
        
        // Level 3 inherits from Level 2 - use same definitions
        // But use Level 3 items as options if needed
        const defsL3 = getDefsForCategory(key); // Inherit from parent
        const existingForL3 = existingByCat[l3Id] || [];
        const existingNamesL3 = new Set(existingForL3.map(n => normalize(n)));
        
        console.log(`         Level 3: ${l3Name} - ${defsL3.length} definitions`);
        
        for (const def of defsL3) {
          if (existingNamesL3.has(normalize(def.name))) continue;
          
          let options = [];
          if (Array.isArray(def.options)) {
            options = def.options.map(v => String(v).trim()).filter(Boolean);
          } else if (def.optionsSource === "level3") {
            // Level 3 uses its own items as options
            const subCat = subCategories.find(s => s.label === rootName);
            const child = subCat?.children?.find(c => c.label === l2Name);
            options = (child?.items || []).map(v => String(v).trim()).filter(Boolean);
          }
          
          const attrData = {
            name: def.name,
            type: def.type || "string",
            isRequired: Boolean(def.isRequired),
            code: def.code || makeSlug(def.name),
            displayType: def.displayType || (def.type === "enum" ? "list" : "text"),
            selectionType: "single",
            category: l3Id
          };
          
          attributesToCreate.push(attrData);
          
          if (options.length > 0) {
            attributeOptionsMap[attrData.code + "_" + l3Id] = options;
          }
        }
      }
    }
  }

  console.log(`\n   ✅ Total attributes to create: ${attributesToCreate.length}`);
  console.log(`   ✅ Total option sets: ${Object.keys(attributeOptionsMap).length}`);

  // Step 5: Create attributes
  console.log("\n📦 Step 5: Creating attributes...");
  
  const batchSize = 5;
  let attrsCreated = 0;
  const createdAttrs = [];

  for (let i = 0; i < attributesToCreate.length; i += batchSize) {
    const batch = attributesToCreate.slice(i, i + batchSize);
    
    if (i % 20 === 0) {
      console.log(`   Progress: ${i}/${attributesToCreate.length}`);
    }
    
    for (const attrData of batch) {
      try {
        const res = await api.post("/api/category-attributes", { data: attrData });
        createdAttrs.push({
          id: res.data.data.id,
          code: attrData.code,
          categoryId: attrData.category
        });
        attrsCreated++;
      } catch (err) {
        // Skip duplicates or errors
      }
    }
    
    await delay(300);
  }

  console.log(`   ✅ Created: ${attrsCreated} attributes`);

  // Step 6: Create options
  console.log("\n📦 Step 6: Creating attribute options...");
  
  const allOptions = [];

  for (const attr of createdAttrs) {
    const key = attr.code + "_" + attr.categoryId;
    const options = attributeOptionsMap[key];
    
    if (!options || options.length === 0) continue;

    for (let i = 0; i < options.length; i++) {
      allOptions.push({
        value: options[i],
        sortOrder: i + 1,
        category_attribute: attr.id
      });
    }
  }

  console.log(`   Total options to create: ${allOptions.length}`);

  // Process options
  const optionBatchSize = 10;
  let optionsCreated = 0;

  for (let i = 0; i < allOptions.length; i += optionBatchSize) {
    const batch = allOptions.slice(i, i + optionBatchSize);
    
    for (const optData of batch) {
      try {
        await api.post("/api/category-attribute-options", { data: optData });
        optionsCreated++;
      } catch (err) {
        // Skip
      }
    }
    
    if (i % 50 === 0) {
      console.log(`   Progress: ${i}/${allOptions.length}`);
    }
    
    await delay(100);
  }

  console.log(`   ✅ Created: ${optionsCreated} options`);

  // Summary
  console.log("\n" + "=".repeat(50));
  console.log("🎉 COMPLETE SEED Finished!");
  console.log("=".repeat(50));
  console.log(`Total attributes created: ${attrsCreated}`);
  console.log(`Total options created: ${optionsCreated}`);
  console.log("");
}

completeSeed().catch(err => {
  console.error("❌ Error:", err.response?.data || err.message);
  process.exit(1);
});
