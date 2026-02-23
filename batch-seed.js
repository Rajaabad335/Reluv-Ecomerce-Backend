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
// BATCH SEED - Process in small batches
// ============================
async function batchSeed() {
  console.log("\n🚀 Batch Seeding Category Attributes...");
  console.log(`📡 Strapi URL: ${STRAPI_URL}\n`);

  // Step 1: Fetch categories
  console.log("📦 Step 1: Fetching categories...");
  const catRes = await api.get("/api/categories", { params: { "pagination[pageSize]": 500 } });
  const categories = catRes.data.data || [];
  console.log(`   ✅ Found ${categories.length} categories`);

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

  const existingByCat = {};
  existingAttrs.forEach(attr => {
    const catId = attr.attributes?.category?.data?.id;
    if (!catId) return;
    if (!existingByCat[catId]) existingByCat[catId] = [];
    existingByCat[catId].push(attr);
  });

  // Step 3: Prepare targets
  console.log("\n📦 Step 3: Preparing attribute data...");
  const globalDefs = seedConfig.globalAttributes || [];

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

  // Prepare all data for creation
  const attributesToCreate = [];
  const attributeOptionsMap = {};

  for (const target of targets) {
    const category = categoryMap[target.categorySlug];
    if (!category) continue;

    const categoryId = category.id;
    const existingForCat = existingByCat[categoryId] || [];
    const existingNames = new Set(existingForCat.map(a => normalize(a.attributes.name)));

    const specificDefs = seedConfig.categorySpecificAttributes?.[target.key] || [];
    const allDefs = [...globalDefs, ...specificDefs];

    for (const def of allDefs) {
      if (existingNames.has(normalize(def.name))) continue;

      let options = [];
      if (Array.isArray(def.options)) {
        options = def.options.map(v => String(v).trim()).filter(Boolean);
      } else if (def.optionsSource === "level3") {
        options = target.items.map(v => String(v).trim()).filter(Boolean);
      }

      const attrData = {
        name: def.name,
        type: def.type || "string",
        isRequired: Boolean(def.isRequired),
        code: def.code || makeSlug(def.name),
        displayType: def.displayType || (def.type === "enum" ? "list" : "text"),
        selectionType: "single",
        category: categoryId
      };

      attributesToCreate.push(attrData);

      if (options.length > 0) {
        attributeOptionsMap[attrData.code + "_" + categoryId] = options;
      }
    }
  }

  console.log(`   ✅ Prepared ${attributesToCreate.length} attributes for creation`);
  console.log(`   ✅ Prepared ${Object.keys(attributeOptionsMap).length} attribute option sets`);

  // Step 4: Create attributes in SMALL batches with delays
  console.log("\n📦 Step 4: Creating attributes in batches...");
  
  const batchSize = 5;  // Small batch size
  let attrsCreated = 0;
  const createdAttrs = [];

  for (let i = 0; i < attributesToCreate.length; i += batchSize) {
    const batch = attributesToCreate.slice(i, i + batchSize);
    console.log(`   Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(attributesToCreate.length/batchSize)}...`);
    
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
        // Skip duplicates
      }
    }
    
    // Delay between batches to let database recover
    await delay(500);
  }

  console.log(`   ✅ Created: ${attrsCreated} attributes`);

  // Step 5: Create options in SMALL batches with delays
  console.log("\n📦 Step 5: Creating attribute options in batches...");
  
  let optionsCreated = 0;
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

  console.log(`   📊 Total options to create: ${allOptions.length}`);

  // Process options in small batches
  const optionBatchSize = 10;
  for (let i = 0; i < allOptions.length; i += optionBatchSize) {
    const batch = allOptions.slice(i, i + optionBatchSize);
    
    if (Math.floor(i/optionBatchSize) % 5 === 0) {
      console.log(`   Processing options batch ${Math.floor(i/optionBatchSize) + 1}/${Math.ceil(allOptions.length/optionBatchSize)}...`);
    }
    
    for (const optData of batch) {
      try {
        await api.post("/api/category-attribute-options", { data: optData });
        optionsCreated++;
      } catch (err) {
        // Skip duplicates
      }
    }
    
    // Small delay between batches
    await delay(200);
  }

  console.log(`   ✅ Created: ${optionsCreated} options`);

  // Summary
  console.log("\n" + "=".repeat(50));
  console.log("🎉 BATCH Seed Complete!");
  console.log("=".repeat(50));
  console.log(`Attributes created: ${attrsCreated}`);
  console.log(`Options created: ${optionsCreated}`);
  console.log("");
}

batchSeed().catch(err => {
  console.error("❌ Error:", err.response?.data || err.message);
  process.exit(1);
});
