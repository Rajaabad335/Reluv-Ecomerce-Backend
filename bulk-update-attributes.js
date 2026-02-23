const axios = require("axios");
const slugify = require("slugify");

// ============================
// CONFIG
// ============================
const STRAPI_URL = "http://localhost:1337";
const API_TOKEN = "3b679467cc5bc1b4c9d5845d170b82b58dfdd8272e7326ad2daebe709790cedd9f68ac191b2ae9b80f39fd1fdd004a0d17a14b0eceda2e265da36b999d982bf3ee8afe91dd8b8843c142f79e254a225a785e3a6e4e69f458dff5d54bcff715c73fbb269523026be0382d012ff4252532cabf477a2bae9d7c303e64c7bdc7ff36";

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

// ============================
// ATTRIBUTE DEFINITIONS
// ============================

// Global attributes for all categories
const globalAttributes = [
  {
    name: "Condition",
    type: "enum",
    isRequired: true,
    options: ["New with tags", "New without tags", "Very good", "Good", "Satisfactory"]
  },
  {
    name: "Brand",
    type: "string",
    isRequired: false
  },
  {
    name: "Color",
    type: "enum",
    isRequired: false,
    options: ["Black", "White", "Grey", "Beige", "Brown", "Red", "Pink", "Purple", "Blue", "Green", "Yellow", "Orange", "Gold", "Silver", "Multicolor"]
  }
];

// Category-specific attributes
const categoryAttributes = {
  "Women > Clothing": [
    { name: "Size", type: "enum", isRequired: true, options: ["XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL"] },
    { name: "Clothing Type", type: "enum", isRequired: false, options: ["Outerwear", "Dresses", "Formal", "Casual", "Jeans", "Skirts", "Tops", "Blazers", "Jackets", "Sweaters"] },
    { name: "Material", type: "string", isRequired: false }
  ],
  "Women > Shoes": [
    { name: "Shoe Size EU", type: "enum", isRequired: true, options: ["35", "36", "37", "38", "39", "40", "41", "42", "43"] },
    { name: "Heel Height", type: "enum", isRequired: false, options: ["Flat", "Low", "Mid", "High"] },
    { name: "Shoe Type", type: "enum", isRequired: false, options: ["Heels", "Flats", "Boots", "Sneakers", "Sandals", "Loafers", "Wedges", "Pumps", "Slippers", "Mules"] }
  ],
  "Women > Bags": [
    { name: "Bag Type", type: "enum", isRequired: false, options: ["Handbags", "Clutches", "Backpacks", "Totes", "Crossbody", "Wallets", "Satchels", "Hobos", "Bucket Bags", "Messenger Bags"] },
    { name: "Material", type: "string", isRequired: false }
  ],
  "Women > Accessories": [
    { name: "Accessory Type", type: "enum", isRequired: false, options: ["Jewelry", "Hats", "Scarves", "Belts", "Sunglasses", "Watches", "Gloves", "Hair Accessories", "Wallets", "Brooches"] },
    { name: "Material", type: "string", isRequired: false }
  ],
  "Women > Beauty": [
    { name: "Product Type", type: "enum", isRequired: false, options: ["Makeup", "Skincare", "Haircare", "Fragrance", "Nail Care", "Tools", "Bath & Body", "Serums", "Masks", "Creams"] }
  ],
  "Men > Clothing": [
    { name: "Size", type: "enum", isRequired: true, options: ["XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL"] },
    { name: "Clothing Type", type: "enum", isRequired: false, options: ["Shirts", "Trousers", "Suits", "Jackets", "Sweaters", "Jeans", "Polos", "Shorts", "T-shirts", "Coats"] },
    { name: "Material", type: "string", isRequired: false }
  ],
  "Men > Shoes": [
    { name: "Shoe Size EU", type: "enum", isRequired: true, options: ["35", "36", "37", "38", "39", "40", "41", "42", "43", "44", "45", "46"] },
    { name: "Shoe Type", type: "enum", isRequired: false, options: ["Sneakers", "Formal", "Boots", "Loafers", "Sandals", "Running Shoes", "Dress Shoes", "Slippers", "Moccasins", "Espadrilles"] }
  ],
  "Men > Accessories": [
    { name: "Accessory Type", type: "enum", isRequired: false, options: ["Watches", "Belts", "Sunglasses", "Wallets", "Ties", "Hats", "Cufflinks", "Bags", "Scarves", "Gloves"] }
  ],
  "Men > Sportswear": [
    { name: "Size", type: "enum", isRequired: true, options: ["XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL"] },
    { name: "Sport Type", type: "enum", isRequired: false, options: ["Jerseys", "Track Pants", "Sneakers", "Hoodies", "Shorts", "T-shirts", "Caps", "Tracksuits", "Sweatshirts", "Socks"] }
  ],
  "Men > Grooming": [
    { name: "Product Type", type: "enum", isRequired: false, options: ["Shaving", "Skincare", "Haircare", "Fragrance", "Beard Care", "Tools", "Bath & Body", "Serums", "Lotions", "Masks"] }
  ],
  "Designer > Brands": [
    { name: "Brand", type: "enum", isRequired: true, options: ["Gucci", "Prada", "LV", "Chanel", "Dior", "Versace", "Fendi", "Balenciaga", "Hermes", "YSL"] }
  ],
  "Designer > Collections": [
    { name: "Collection", type: "enum", isRequired: false, options: ["Spring", "Summer", "Autumn", "Winter", "Resort", "Capsule", "Limited", "Streetwear", "Haute Couture", "Collaborations"] }
  ],
  "Designer > Shoes": [
    { name: "Shoe Size EU", type: "enum", isRequired: true, options: ["35", "36", "37", "38", "39", "40", "41", "42", "43", "44", "45"] },
    { name: "Shoe Type", type: "enum", isRequired: false, options: ["Sneakers", "Boots", "Loafers", "Heels", "Sandals", "Flats", "Pumps", "Mules", "Wedges", "Slides"] }
  ],
  "Designer > Bags": [
    { name: "Bag Type", type: "enum", isRequired: false, options: ["Totes", "Clutches", "Backpacks", "Crossbody", "Satchels", "Hobos", "Bucket Bags", "Messenger Bags", "Wallets", "Pouches"] }
  ]
};

// ============================
// HELPER FUNCTIONS
// ============================

async function getCategories() {
  // Fetch all categories with pagination
  const allCategories = [];
  let page = 1;
  let totalPages = 1;
  
  do {
    const res = await api.get(`/api/categories?pagination[page]=${page}&pagination[pageSize]=100`);
    const data = res.data.data;
    if (data && data.length > 0) {
      allCategories.push(...data);
    }
    totalPages = res.data.meta?.pagination?.pageCount || 1;
    page++;
  } while (page <= totalPages);
  
  return allCategories;
}

function findCategoryByKey(categories, key) {
  const [parentName, childName] = key.split(" > ");
  
  // Find by exact name match for the child category
  const targetName = childName || parentName;
  console.log(`    🔍 Looking for category: ${targetName}`);
  
  // Find category by name (exact match)
  const found = categories.find(c => {
    const name = c.attributes?.name;
    return name === targetName;
  });
  
  if (found) {
    console.log(`    ✅ Found: ${found.attributes.name} (slug: ${found.attributes.slug})`);
    return found;
  }
  
  // Try partial match on name
  const partial = categories.find(c => {
    const name = c.attributes?.name;
    return name && name.toLowerCase().includes(targetName.toLowerCase().split(" ")[0]);
  });
  
  if (partial) {
    console.log(`    ⚠️ Partial match: ${partial.attributes.name} (${partial.attributes.slug})`);
    return partial;
  }
  
  return null;
}

async function getExistingAttributes(categoryId) {
  const res = await api.get(`/api/category-attributes?filters[category][id][$eq]=${categoryId}&pagination[limit]=50`);
  return res.data.data;
}

async function createAttribute(categoryId, attrData) {
  const payload = {
    data: {
      name: attrData.name,
      type: attrData.type,
      isRequired: attrData.isRequired || false,
      displayType: attrData.type === "enum" ? "list" : "text",
      code: makeSlug(attrData.name),
      category: categoryId
    }
  };
  
  const res = await api.post("/api/category-attributes", payload);
  return res.data.data;
}

async function createAttributeOptions(attributeId, options) {
  const results = [];
  for (let i = 0; i < options.length; i++) {
    const payload = {
      data: {
        value: options[i],
        sortOrder: i + 1,
        category_attribute: attributeId
      }
    };
    
    try {
      const res = await api.post("/api/category-attribute-options", payload);
      results.push(res.data.data);
    } catch (err) {
      console.error(`  ⚠️ Failed to create option: ${options[i]}`);
    }
  }
  return results;
}

// ============================
// MAIN SEED FUNCTION
// ============================

async function seed() {
  console.log("🚀 Starting Bulk Category Attributes Seeding...\n");
  console.time("Seeding completed in");
  
  // Get all categories
  console.log("📥 Fetching categories from Strapi...");
  const categories = await getCategories();
  console.log(`✅ Found ${categories.length} categories\n`);
  
  let totalAttributes = 0;
  let totalOptions = 0;
  let totalCategoriesProcessed = 0;
  
  // Process each category-specific attribute
  for (const [categoryKey, attributes] of Object.entries(categoryAttributes)) {
    console.log(`\n📦 Processing: ${categoryKey}`);
    
    const category = findCategoryByKey(categories, categoryKey);
    if (!category) {
      console.log(`  ⚠️ Category not found: ${categoryKey}`);
      continue;
    }
    
    const categoryId = category.id;
    const categoryName = category.attributes.name;
    console.log(`  → Found category: ${categoryName} (ID: ${categoryId})`);
    
    // Get existing attributes for this category
    const existingAttrs = await getExistingAttributes(categoryId);
    const existingNames = new Set(existingAttrs.map(a => a.attributes.name.toLowerCase()));
    
    console.log(`  → Existing attributes: ${existingAttrs.length}`);
    
    // Add global attributes first
    for (const globalAttr of globalAttributes) {
      if (existingNames.has(globalAttr.name.toLowerCase())) {
        console.log(`  ⏭️  Skipping (exists): ${globalAttr.name}`);
        continue;
      }
      
      try {
        const created = await createAttribute(categoryId, globalAttr);
        totalAttributes++;
        
        if (globalAttr.options && globalAttr.options.length > 0) {
          await createAttributeOptions(created.id, globalAttr.options);
          totalOptions += globalAttr.options.length;
        }
        
        console.log(`  ✅ Created: ${globalAttr.name}`);
      } catch (err) {
        console.error(`  ❌ Failed: ${globalAttr.name}`);
      }
    }
    
    // Add category-specific attributes
    for (const attr of attributes) {
      if (existingNames.has(attr.name.toLowerCase())) {
        console.log(`  ⏭️  Skipping (exists): ${attr.name}`);
        continue;
      }
      
      try {
        const created = await createAttribute(categoryId, attr);
        totalAttributes++;
        
        if (attr.options && attr.options.length > 0) {
          await createAttributeOptions(created.id, attr.options);
          totalOptions += attr.options.length;
        }
        
        console.log(`  ✅ Created: ${attr.name} (${attr.options?.length || 0} options)`);
      } catch (err) {
        console.error(`  ❌ Failed: ${attr.name}`);
      }
    }
    
    totalCategoriesProcessed++;
  }
  
  console.timeEnd("Seeding completed in");
  console.log("\n🎉 Seeding Summary:");
  console.log(`   Categories processed: ${totalCategoriesProcessed}`);
  console.log(`   Attributes created: ${totalAttributes}`);
  console.log(`   Options created: ${totalOptions}`);
}

seed().catch(err => {
  console.error("❌ Seed failed:", err.message);
  console.error("Full error:", err);
  process.exit(1);
});
