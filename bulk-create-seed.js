const axios = require("axios");
const slugify = require("slugify");

// ============================
// CONFIG
// ============================
const STRAPI_URL = process.env.STRAPI_URL || "http://localhost:1337";
const API_TOKEN = "3b679467cc5bc1b4c9d5845d170b82b58dfdd8272e7326ad2daebe709790cedd9f68ac191b2ae9b80f39fd1fdd004a0d17a14b0eceda2e265da36b999d982bf3ee8afe91dd8b8843c142f79e254a225a785e3a6e4e69f458dff5d54bcff715c73fbb269523026be0382d012ff4252532cabf477a2bae9d7c303e64c7bdc7ff36";

const seedConfig = require("./seed-data/category-attributes.seed.json");
const { subCategories } = require("./subCatagories.js");

const api = axios.create({
  baseURL: STRAPI_URL,
  headers: {
    Authorization: `Bearer ${API_TOKEN}`,
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
// BULK CREATE - Uses Strapi's createMany
// ============================
async function bulkCreateAttributes() {
  console.log("\n🚀 BULK Creating Category Attributes...");
  console.log(`📡 Strapi URL: ${STRAPI_URL}\n`);

  // Step 1: Fetch categories
  console.log("📦 Step 1: Fetching categories...");
  const catRes = await api.get("/api/categories", { params: { "pagination[pageSize]": 500 } });
  const categories = catRes.data.data || [];
  console.log(`   ✅ Found ${categories.length} categories`);

  // Build category lookup
  const categoryMap = {};
  categories.forEach(cat => {
    const attrs = cat.attributes || cat;
    const slug = attrs?.slug;
    const id = cat.id;
    if (slug && id) categoryMap[slug] = { id, name: attrs.name };
  });

  // Step 2: Fetch existing attributes
  console.log("\n📦 Step 2: Fetching existing attributes...");
  const attrRes = await api.get("/api/category-attributes", { 
    params: { "pagination[pageSize]": 500, populate: "category" } 
  });
  const existingAttrs = attrRes.data.data || [];
  console.log(`   ✅ Found ${existingAttrs.length} existing attributes`);

  // Build existing attributes map
  const existingByCat = {};
  existingAttrs.forEach(attr => {
    const catId = attr.attributes?.category?.data?.id;
    if (!catId) return;
    if (!existingByCat[catId]) existingByCat[catId] = [];
    existingByCat[catId].push(attr);
  });

  // Step 3: Prepare all attribute data
  console.log("\n📦 Step 3: Preparing attribute data...");
  const globalDefs = seedConfig.globalAttributes || [];

  const attributesToCreate = [];
  const optionsToCreateByAttr = {};

  // Build targets
  const targets = [];
  for (const top of subCategories) {
    const topName = String(top.label || "").trim();
    const children = Array.isArray(top.children) ? top.children : [];

    for (const child of children) {
      const secondName = String(child.label || "").trim();
      if (!secondName || secondName === "ALL") continue;

      targets.push({
        key: `${topName} > ${secondName}`,
        categorySlug: makeSlug(secondName, topName),
        items: Array.isArray(child.items) ? child.items : [],
      });
    }
  }

  console.log(`   ✅ Prepared ${targets.length} category targets`);

  // Process each target and prepare bulk data
  for (const target of targets) {
    const category = categoryMap[target.categorySlug];
    if (!category) continue;

    const categoryId = category.id;
    const existingForCat = existingByCat[categoryId] || [];
    const existingNames = new Set(existingForCat.map(a => normalize(a.attributes.name)));

    // Get definitions for this category
    const specificDefs = seedConfig.categorySpecificAttributes?.[target.key] || [];
    const allDefs = [...globalDefs, ...specificDefs];

    for (const def of allDefs) {
      if (existingNames.has(normalize(def.name))) continue;

      // Resolve options
      let options = [];
      if (Array.isArray(def.options)) {
        options = def.options.map(v => String(v).trim()).filter(Boolean);
      } else if (def.optionsSource === "level3") {
        options = target.items.map(v => String(v).trim()).filter(Boolean);
      }

      // Create attribute data (without relations - we'll add them separately)
      attributesToCreate.push({
        name: def.name,
        type: def.type || "string",
        isRequired: Boolean(def.isRequired),
        code: def.code || makeSlug(def.name),
        displayType: def.displayType || (def.type === "enum" ? "list" : "text"),
        selectionType: "single",
        category: categoryId  // Use direct ID for bulk create
      });
    }
  }

  console.log(`   ✅ Prepared ${attributesToCreate.length} attributes for bulk create`);

  // Step 4: Bulk create attributes
  console.log("\n📦 Step 4: Bulk creating attributes...");

  // Strapi bulk create - split into chunks of 100
  const chunkSize = 100;
  let attrsCreated = 0;

  for (let i = 0; i < attributesToCreate.length; i += chunkSize) {
    const chunk = attributesToCreate.slice(i, i + chunkSize);
    
    try {
      // Use bulk create endpoint
      const res = await api.post("/api/category-attributes/bulk", {
        entries: chunk
      });
      
      const created = res.data.results || [];
      attrsCreated += created.length;
      
      // Store the created attributes with their IDs for option creation
      created.forEach((attr, idx) => {
        const originalDef = chunk[idx];
        if (originalDef.type === "enum" && originalDef.displayType === "list") {
          // Get options from definition
          let options = [];
          const specificDefs = seedConfig.categorySpecificAttributes?.[target?.key] || [];
          const allDefs = [...globalDefs, ...specificDefs];
          const matchingDef = allDefs.find(d => d.name === originalDef.name);
          
          if (matchingDef) {
            if (Array.isArray(matchingDef.options)) {
              options = matchingDef.options;
            } else if (matchingDef.optionsSource === "level3") {
              options = target?.items || [];
            }
          }
          
          if (options.length > 0) {
            optionsToCreateByAttr[attr.id] = options.map((opt, optIdx) => ({
              value: opt,
              sortOrder: optIdx + 1,
              category_attribute: attr.id
            }));
          }
        }
      });
      
      console.log(`   📊 Created ${attrsCreated} / ${attributesToCreate.length} attributes`);
      
    } catch (err) {
      console.log(`   ⚠️ Bulk create error: ${err.response?.data?.error?.message || err.message}`);
      console.log(`   📝 Falling back to individual create...`);
      
      // Fallback to individual create
      for (const entry of chunk) {
        try {
          await api.post("/api/category-attributes", { data: entry });
          attrsCreated++;
        } catch (e) {
          // Skip errors
        }
      }
    }
  }

  console.log(`   ✅ Total attributes created: ${attrsCreated}`);

  // Step 5: Bulk create options
  console.log("\n📦 Step 5: Bulk creating attribute options...");
  
  const allOptions = [];
  const attrOptionsMap = {};

  // Get all created attributes with their options
  for (const [attrId, options] of Object.entries(optionsToCreateByAttr)) {
    for (const opt of options) {
      allOptions.push(opt);
      if (!attrOptionsMap[attrId]) attrOptionsMap[attrId] = [];
      attrOptionsMap[attrId].push(opt);
    }
  }

  console.log(`   ✅ Prepared ${allOptions.length} options for bulk create`);

  // Bulk create options
  let optionsCreated = 0;
  for (let i = 0; i < allOptions.length; i += chunkSize) {
    const chunk = allOptions.slice(i, i + chunkSize);
    
    try {
      const res = await api.post("/api/category-attribute-options/bulk", {
        entries: chunk
      });
      optionsCreated += (res.data.results || []).length;
    } catch (err) {
      // Fallback to individual
      for (const entry of chunk) {
        try {
          await api.post("/api/category-attribute-options", { data: entry });
          optionsCreated++;
        } catch (e) { /* skip */ }
      }
    }
  }

  console.log(`   ✅ Total options created: ${optionsCreated}`);

  // Summary
  console.log("\n" + "=".repeat(50));
  console.log("🎉 BULK Seed Complete!");
  console.log("=".repeat(50));
  console.log(`Attributes created: ${attrsCreated}`);
  console.log(`Options created: ${optionsCreated}`);
  console.log("");
}

bulkCreateAttributes().catch(err => {
  console.error("❌ Error:", err.response?.data || err.message);
  process.exit(1);
});
