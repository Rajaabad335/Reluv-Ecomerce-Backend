const axios = require("axios");
const slugify = require("slugify");

// ============================
// CONFIG
// ============================
const STRAPI_URL = process.env.STRAPI_URL || "http://localhost:1337";
const API_TOKEN = process.env.STRAPI_API_TOKEN || "3b679467cc5bc1b4c9d5845d170b82b58dfdd8272e7326ad2daebe709790cedd9f68ac191b2ae9b80f39fd1fdd004a0d17a14b0eceda2e265da36b999d982bf3ee8afe91dd8b8843c142f79e254a225a785e3a6e4e69f458dff5d54bcff715c73fbb269523026be0382d012ff4252532cabf477a2bae9d7c303e64c7bdc7ff36";

// Import seed data configuration
const seedConfig = require("./seed-data/category-attributes.seed.json");
const { subCategories } = require("./subCatagories.js");

// ============================
// AXIOS SETUP
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

function normalize(value) {
  return String(value).trim().toLowerCase();
}

// ============================
// HELPER FUNCTIONS
// ============================

// Fetch all categories with pagination
async function fetchAllCategories() {
  const categories = [];
  let page = 1;
  const pageSize = 100;
  
  while (true) {
    const res = await api.get("/api/categories", {
      params: {
        "pagination[page]": page,
        "pagination[pageSize]": pageSize,
      },
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

// Fetch all category attributes
async function fetchAllCategoryAttributes() {
  const attributes = [];
  let page = 1;
  const pageSize = 100;
  
  while (true) {
    const res = await api.get("/api/category-attributes", {
      params: {
        "pagination[page]": page,
        "pagination[pageSize]": pageSize,
      },
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

// Fetch all attribute options
async function fetchAllAttributeOptions() {
  const options = [];
  let page = 1;
  const pageSize = 100;
  
  while (true) {
    const res = await api.get("/api/category-attribute-options", {
      params: {
        "pagination[page]": page,
        "pagination[pageSize]": pageSize,
      },
    });
    
    const data = res.data.data;
    if (!data || data.length === 0) break;
    
    options.push(...data);
    
    const pagination = res.data.meta?.pagination;
    if (!pagination || page >= pagination.pageCount) break;
    page++;
  }
  
  return options;
}

// Create category attribute
async function createAttribute(categoryId, attributeData) {
  try {
    const res = await api.post(
      "/api/category-attributes",
      {
        data: {
          name: attributeData.name,
          type: attributeData.type,
          isRequired: attributeData.isRequired || false,
          code: attributeData.code || makeSlug(attributeData.name),
          placeholder: attributeData.placeholder || "",
          description: attributeData.description || "",
          displayType: attributeData.displayType || (attributeData.type === "enum" ? "list" : "text"),
          selectionType: attributeData.selectionType || "single",
          selectionLimit: attributeData.selectionLimit || 1,
          category: { id: categoryId },
        },
      },
      {
        params: { status: "published" },
      }
    );
    return res.data.data;
  } catch (err) {
    console.error(`  ❌ Error creating attribute "${attributeData.name}":`, err.response?.data?.error?.message || err.message);
    return null;
  }
}

// Create attribute option
async function createOption(attributeId, value, sortOrder) {
  try {
    const res = await api.post(
      "/api/category-attribute-options",
      {
        data: {
          value: value,
          sortOrder: sortOrder,
          category_attribute: { id: attributeId },
        },
      },
      {
        params: { status: "published" },
      }
    );
    return res.data.data;
  } catch (err) {
    console.error(`    ❌ Error creating option "${value}":`, err.response?.data?.error?.message || err.message);
    return null;
  }
}

// Build target categories from subCategories
function buildTargets() {
  const targets = [];
  
  for (const top of subCategories) {
    const topName = String(top.label || "").trim();
    const children = Array.isArray(top.children) ? top.children : [];
    
    for (const child of children) {
      const secondName = String(child.label || "").trim();
      if (!secondName || secondName === "ALL") {
        continue;
      }
      
      targets.push({
        key: `${topName} > ${secondName}`,
        categorySlug: makeSlug(secondName, topName),
        items: Array.isArray(child.items) ? child.items : [],
      });
    }
  }
  
  return targets;
}

// Resolve options for an attribute
function resolveOptions(definition, target) {
  // If options are explicitly provided
  if (Array.isArray(definition.options)) {
    return definition.options.map((v) => String(v).trim()).filter(Boolean);
  }
  
  // If options should come from level 3 categories
  if (definition.optionsSource === "level3") {
    return (target.items || []).map((v) => String(v).trim()).filter(Boolean);
  }
  
  return [];
}

// Merge global and category-specific attributes
function mergeDefinitions(globalDefs, specificDefs, target) {
  const merged = new Map();
  const allDefs = [...globalDefs, ...specificDefs];
  
  for (const def of allDefs) {
    const name = String(def.name || "").trim();
    if (!name) continue;
    
    const key = normalize(name);
    if (!merged.has(key)) {
      merged.set(key, {
        name,
        type: def.type || "string",
        isRequired: Boolean(def.isRequired),
        code: def.code || makeSlug(name),
        placeholder: def.placeholder || "",
        description: def.description || "",
        displayType: def.displayType || (def.type === "enum" ? "list" : "text"),
        selectionType: def.selectionType || "single",
        selectionLimit: def.selectionLimit || 1,
        options: resolveOptions(def, target),
      });
    }
  }
  
  return [...merged.values()];
}

// ============================
// MAIN SEED FUNCTION
// ============================
async function seed() {
  console.log("🚀 Starting Bulk Seed for Category Attributes...");
  console.log(`📡 Strapi URL: ${STRAPI_URL}`);
  console.log("");
  
  console.log("📊 Step 1: Fetching existing data from Strapi...");
  
  // Fetch existing categories
  console.log("  - Fetching categories...");
  const categories = await fetchAllCategories();
  console.log(`  ✅ Found ${categories.length} categories`);
  
  // Fetch existing attributes
  console.log("  - Fetching existing attributes...");
  const existingAttributes = await fetchAllCategoryAttributes();
  console.log(`  ✅ Found ${existingAttributes.attributes?.length || existingAttributes.length || 0} existing attributes`);
  
  // Build category lookup by slug
  const categoryBySlug = {};
  categories.forEach(cat => {
    categoryBySlug[cat.attributes.slug] = cat;
  });
  
  // Build existing attributes lookup
  const existingAttrsByCategory = {};
  existingAttributes.forEach(attr => {
    const catId = attr.attributes.category?.data?.id;
    if (catId) {
      if (!existingAttrsByCategory[catId]) existingAttrsByCategory[catId] = [];
      existingAttrsByCategory[catId].push(attr);
    }
  });
  
  console.log("");
  console.log("📊 Step 2: Processing category attributes...");
  
  // Build targets
  const targets = buildTargets();
  const globalDefs = seedConfig.globalAttributes || [];
  
  let stats = {
    categoriesProcessed: 0,
    attributesCreated: 0,
    attributesReused: 0,
    optionsCreated: 0,
    optionsReused: 0,
    missingCategories: 0,
  };
  
  // Process each target
  for (const target of targets) {
    const category = categoryBySlug[target.categorySlug];
    if (!category) {
      console.log(`  ⚠️ Category not found for slug: ${target.categorySlug}`);
      stats.missingCategories++;
      continue;
    }
    
    const categoryId = category.id;
    const categoryName = category.attributes.name;
    
    // Get specific attributes for this category
    const specificDefs = seedConfig.categorySpecificAttributes?.[target.key] || [];
    const mergedDefs = mergeDefinitions(globalDefs, specificDefs, target);
    
    console.log(`\n  📁 ${categoryName} (${target.key})`);
    console.log(`     Processing ${mergedDefs.length} attributes...`);
    
    stats.categoriesProcessed++;
    
    // Process each attribute
    for (const def of mergedDefs) {
      // Check if attribute already exists
      const existingAttrs = existingAttrsByCategory[categoryId] || [];
      const existingAttr = existingAttrs.find(
        a => normalize(a.attributes.name) === normalize(def.name)
      );
      
      if (existingAttr) {
        console.log(`     ✅ Reusing: ${def.name}`);
        stats.attributesReused++;
        
        // Check and create options for this attribute
        const attrId = existingAttr.id;
        const existingOptionsRes = await api.get("/api/category-attribute-options", {
          params: {
            "filters[category_attribute][id][$eq]": attrId,
            "pagination[pageSize]": 200,
          },
        });
        
        const existingOptions = existingOptionsRes.data.data || [];
        const existingOptionValues = new Set(
          existingOptions.map(o => normalize(o.attributes.value))
        );
        
        // Create new options if needed
        for (let i = 0; i < def.options.length; i++) {
          const optionValue = def.options[i];
          if (!existingOptionValues.has(normalize(optionValue))) {
            await createOption(attrId, optionValue, i + 1);
            stats.optionsCreated++;
          } else {
            stats.optionsReused++;
          }
        }
      } else {
        // Create new attribute
        const newAttr = await createAttribute(categoryId, def);
        if (newAttr) {
          console.log(`     ✅ Created: ${def.name} (${def.type})`);
          stats.attributesCreated++;
          
          // Create options for this attribute
          const attrId = newAttr.id;
          for (let i = 0; i < def.options.length; i++) {
            await createOption(attrId, def.options[i], i + 1);
            stats.optionsCreated++;
          }
        }
      }
    }
  }
  
  console.log("\n");
  console.log("🎉 Bulk Seed Completed!");
  console.log("=======================");
  console.log(`Categories Processed: ${stats.categoriesProcessed}`);
  console.log(`Attributes Created: ${stats.attributesCreated}`);
  console.log(`Attributes Reused: ${stats.attributesReused}`);
  console.log(`Options Created: ${stats.optionsCreated}`);
  console.log(`Options Reused: ${stats.optionsReused}`);
  console.log(`Missing Categories: ${stats.missingCategories}`);
  console.log("");
  
  return stats;
}

// Run the seed
seed().catch((err) => {
  console.error("❌ Seed failed:", err?.response?.data || err.message || err);
  process.exit(1);
});
