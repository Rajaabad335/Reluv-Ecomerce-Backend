const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '.tmp', 'data.db');
const db = new Database(dbPath);

console.log("=== Analyzing Strapi SQLite Database ===\n");

// Get all tables
const tables = db.prepare(`
  SELECT name FROM sqlite_master 
  WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_%' 
  ORDER BY name
`).all();

console.log("=== Tables ===");
tables.forEach(t => console.log(`- ${t.name}`));

// Helper function to get table data
function getTableData(tableName, limit = 10) {
  try {
    const data = db.prepare(`SELECT * FROM ${tableName} LIMIT ?`).all(limit);
    return data;
  } catch (e) {
    return [];
  }
}

// Analyze categories table
console.log("\n=== Categories Table ===");
const categories = getTableData('categories', 100);
console.log(`Total categories: ${categories.length}`);
console.log("Sample categories:");
categories.slice(0, 5).forEach(c => {
  console.log(`  ID: ${c.id}, Name: ${c.name}, Slug: ${c.slug}, Parent: ${c.category_id}`);
});

// Group by level
const level1 = categories.filter(c => !c.category_id);
const level2 = categories.filter(c => c.category_id && !c.parent_categories_id);
const level3 = categories.filter(c => c.parent_categories_id);

console.log(`\nLevel 1 (Parent): ${level1.length}`);
console.log(`Level 2 (Child): ${level2.length}`);
console.log(`Level 3 (Sub-child): ${level3.length}`);

// Show Level 1 categories
console.log("\n=== Level 1 Categories ===");
level1.forEach(c => console.log(`  - ${c.name} (ID: ${c.id})`));

// Show Level 2 categories with their parent
console.log("\n=== Level 2 Categories ===");
level2.forEach(c => {
  const parent = categories.find(p => p.id === c.category_id);
  const parentName = parent ? parent.name : "None";
  console.log(`  - ${c.name} (ID: ${c.id}) -> Parent: ${parentName}`);
});

// Analyze category_attributes table
console.log("\n=== Category Attributes Table ===");
const categoryAttributes = getTableData('category_attributes', 100);
console.log(`Total category attributes: ${categoryAttributes.length}`);

// Group attributes by category_id
const attrsByCategory = {};
categoryAttributes.forEach(attr => {
  const catId = attr.category_id;
  if (!catId) return;
  if (!attrsByCategory[catId]) attrsByCategory[catId] = [];
  attrsByCategory[catId].push(attr);
});

console.log("\n=== Attributes per Category ===");
Object.keys(attrsByCategory).slice(0, 10).forEach(catId => {
  const cat = categories.find(c => c.id === parseInt(catId));
  const catName = cat ? cat.name : `ID: ${catId}`;
  console.log(`\n${catName} (${attrsByCategory[catId].length} attributes):`);
  attrsByCategory[catId].forEach(attr => {
    console.log(`  - ${attr.name} (${attr.type})`);
  });
});

// Analyze category_attribute_options table
console.log("\n=== Category Attribute Options Table ===");
const attrOptions = getTableData('category_attribute_options', 500);
console.log(`Total attribute options: ${attrOptions.length}`);

// Analyze brands table
console.log("\n=== Brands Table ===");
const brands = getTableData('brands', 100);
console.log(`Total brands: ${brands.length}`);
brands.slice(0, 10).forEach(b => console.log(`  - ${b.name}`));
if (brands.length > 10) console.log(`  ... and ${brands.length - 10} more`);

// Analyze sizes table
console.log("\n=== Sizes Table ===");
const sizes = getTableData('sizes', 100);
console.log(`Total sizes: ${sizes.length}`);
sizes.slice(0, 10).forEach(s => console.log(`  - ${s.name} (Category ID: ${s.category_id})`));
if (sizes.length > 10) console.log(`  ... and ${sizes.length - 10} more`);

// Analyze products table
console.log("\n=== Products Table ===");
const products = getTableData('products', 10);
console.log(`Total products: ${db.prepare('SELECT COUNT(*) as count FROM products').get().count}`);
console.log("Sample product columns:", products.length > 0 ? Object.keys(products[0]) : "No products");

// Check for product_attribute_values table
console.log("\n=== Product Attribute Values Table ===");
const productAttrValues = getTableData('product_attribute_values', 100);
console.log(`Total product attribute values: ${productAttrValues.length}`);

// Summary
console.log("\n=== Summary ===");
console.log(`Categories: ${categories.length}`);
console.log(`Category Attributes: ${categoryAttributes.length}`);
console.log(`Attribute Options: ${attrOptions.length}`);
console.log(`Brands: ${brands.length}`);
console.log(`Sizes: ${sizes.length}`);
console.log(`Products: ${db.prepare('SELECT COUNT(*) as count FROM products').get().count}`);
console.log(`Product Attribute Values: ${productAttrValues.length}`);

// Export category structure
console.log("\n=== Category Structure for Seeding ===");
const categoryStructure = {};
level1.forEach(l1 => {
  const l1Name = l1.name;
  const l1Id = l1.id;
  
  const children = level2.filter(c => c.category_id === l1Id);
  const childData = children.map(l2 => {
    const l2Id = l2.id;
    const subChildren = level3.filter(c => c.parent_categories_id && c.parent_categories_id.includes(l2Id));
    return {
      name: l2.name,
      id: l2Id,
      items: subChildren.map(s => s.name)
    };
  });
  
  categoryStructure[l1Name] = childData;
});

console.log(JSON.stringify(categoryStructure, null, 2));

db.close();
