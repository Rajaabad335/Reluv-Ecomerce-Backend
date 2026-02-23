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

const sizesData = require("./seed-data/sizes.seed.json").sizes;

// Debug function to check available categories
async function debugCategories() {
  console.log("\n=== DEBUG: Fetching all categories ===");
  try {
    // Get total count first
    const countRes = await api.get("/api/categories?pagination[pageSize]=1");
    const totalCount = countRes.data?.meta?.pagination?.total || 0;
    console.log("Total category count:", totalCount);

    // Now fetch all categories
    const res = await api.get("/api/categories?pagination[pageSize]=" + Math.min(totalCount, 200));
    const rawData = res.data.data || [];

    console.log("Fetched raw data length:", rawData.length);

    // Parse each item carefully
    const parsedItems = [];
    for (const item of rawData) {
      if (!item) continue;
      
      const id = item.id;
      let name = null;

      // Handle Strapi response formats
      if (item.attributes && typeof item.attributes === 'object') {
        name = item.attributes.name;
      } else if (item.name) {
        name = item.name;
      }

      if (name) {
        parsedItems.push({ id: id, name: name });
      }
    }

    // Show first few items
    console.log("\nFirst few parsed items:");
    for (let i = 0; i < Math.min(parsedItems.length, 15); i++) {
      const itm = parsedItems[i];
      console.log("- ID:" + itm.id + ", Name:" + itm.name);
    }

    return { allCategories: parsedItems };
  } catch (err) {
    console.error("Error fetching categories:", err.message);
    if (err.response) {
      console.error("Status:", err.response.status);
      console.error("Data:", JSON.stringify(err.response.data));
    }
    return { allCategories: [] };
  }
}

async function getAllSizes() {
  try {
    const res = await api.get("/api/sizes?pagination[limit]=200");
    return res.data.data || [];
  } catch (err) {
    console.error("[getAllSizes] Error:", err.message);
    if (err.response) {
      console.error("[getAllSizes] Response data:", JSON.stringify(err.response.data));
    }
    return [];
  }
}

async function deleteSize(sizeId) {
  try {
    await api.delete("/api/sizes/" + sizeId);
    return true;
  } catch (err) {
    console.error("[deleteSize] Error deleting " + sizeId + ":", err.message);
    return false;
  }
}

async function findCategoryByName(name, categoriesCache) {
  if (categoriesCache && categoriesCache.allCategories) {
    const searchName = name.toLowerCase().trim();

    // Try exact name match first
    for (const cat of categoriesCache.allCategories) {
      const catName = (cat.name || "").toLowerCase().trim();
      if (catName === searchName) {
        return cat;
      }
    }

    // Try partial match
    for (const cat of categoriesCache.allCategories) {
      const catName = (cat.name || "").toLowerCase().trim();
      if (catName.includes(searchName) || searchName.includes(catName)) {
        console.log("[findCategoryByName] Found partial match for '" + name + "': " + cat.name);
        return cat;
      }
    }

    // Log what categories ARE available for debugging
    console.log("[findCategoryByName] Category '" + name + "' not found. Available categories:");
    const availableNames = categoriesCache.allCategories.slice(0, 10).map(c => c.name);
    console.log("  Sample: " + availableNames.join(", "));
  }
  return null;
}

async function createSize(sizeInfo, categoryIds) {
  try {
    // For manyToMany relation in Strapi v5, we use 'categories' field
    // and pass array of category IDs directly
    const sizeData = {
      name: sizeInfo.name,
      slug: (sizeInfo.slug || sizeInfo.name.toLowerCase().replace(/[^a-z0-9]/g, "-"))
    };
    
    console.log("[createSize] Creating size:", JSON.stringify(sizeData));
    const res = await api.post("/api/sizes", { data: sizeData });
    
    // If we have categories, we need to use the relation endpoint
    if (categoryIds.length > 0 && res.data && res.data.data) {
      const sizeId = res.data.data.id;
      // Use Strapi's relation API for manyToMany
      for (const catId of categoryIds) {
        const catEntityId = catId.id || catId;
        try {
          await api.post(`/api/sizes/${sizeId}/categories`, {
            data: { id: catEntityId }
          });
          console.log("[createSize] Linked size to category ID:", catEntityId);
        } catch (linkErr) {
          console.warn("[createSize] Could not link category:", linkErr.message);
        }
      }
    }

    if (!res.data || !res.data.data) {
      console.warn("[createSize] No data returned from POST");
    } else {
      console.log("[createSize] Created with categories:", categoryIds.map(c => c.id || c).join(", "));
    }
    return res;
  } catch (err) {
    let errMsg = "Error creating size [" + (typeof sizeInfo === "object" ? String(sizeInfo.name) : "unknown") + "]: ";
    if (err.response && err.response.data && err.response.data.error) {
      errMsg += err.response.data.error.message;
    } else if (err.message) {
      errMsg += err.message;
    } else {
      errMsg += JSON.stringify(err);
    }
    console.log(errMsg);
    return null;
  }
}

async function sizeExistsByName(name) {
  try {
    const res = await api.get("/api/sizes?filters[name][$eq]=" + encodeURIComponent(name));
    return res.data.data.length > 0;
  } catch (err) {
    return false;
  }
}

async function seed() {
  console.log("=== Starting Sizes seeding with category relations ===\n");

  // First, debug what categories exist
  const categoriesCache = await debugCategories();

  let sizeList = await getAllSizes();
  console.log("\nFound " + sizeList.length + " sizes in database");

  console.log("\nDeleting all existing sizes...");
  for (let i = 0; i < sizeList.length; i++) {
    const item = sizeList[i];
    await deleteSize(item.id);
    console.log("Deleted size ID: " + item.id);
  }

  console.log("\n=== Seeding new sizes from JSON with category relations ===\n");

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < sizesData.length; i++) {
    const size = sizesData[i];
    console.log("Processing: " + size.name + " (categories: " + (size.categories || []).join(", ") + ")");

    const exists = await sizeExistsByName(size.name);
    if (exists) {
      console.log("  -> Skipping " + size.name + " - already exists");
      skipped++;
      continue;
    }

    // Find category IDs from the categories array
    const categoryIds = [];
    if (size.categories && size.categories.length > 0) {
      for (const catName of size.categories) {
        const cat = await findCategoryByName(catName, categoriesCache);
        if (cat) {
          categoryIds.push({ id: cat.id });
        } else {
          console.log("  ! Category not found: " + catName);
        }
      }
    }

    const result = await createSize(size, categoryIds);
    if (result) {
      console.log("  [OK] Created: " + size.name + " with relation to: " + (size.categories || []).join(", "));
      created++;
    } else {
      console.log("  [FAIL] Failed to create: " + size.name);
      failed++;
    }
  }

  console.log("\n=== Seeding Complete ===");
  console.log("Created: " + created);
  console.log("Skipped: " + skipped);
  console.log("Failed: " + failed);
  console.log("Total: " + sizesData.length);
}

seed().then(function() {
  console.log("\nDone");
}).catch(function(err) {
  console.log("Seed failed: " + err.message);
  process.exit(1);
});
