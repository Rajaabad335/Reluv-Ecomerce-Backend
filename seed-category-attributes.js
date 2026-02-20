const axios = require("axios");
const slugify = require("slugify");

const seedConfig = require("./seed-data/category-attributes.seed.json");
const { subCategories } = require("./subCatagories.js");

const STRAPI_URL = process.env.STRAPI_URL || "http://localhost:1337";
const API_TOKEN = process.env.STRAPI_API_TOKEN || process.env.API_TOKEN;
const ATTACH_MODE = process.env.ATTRIBUTE_ATTACH_MODE || seedConfig.attachMode || "level2";

if (!API_TOKEN) {
  throw new Error("Missing STRAPI_API_TOKEN (or API_TOKEN) environment variable.");
}

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

function keyFor(top, second) {
  return `${top} > ${second}`;
}

function normalize(value) {
  return String(value).trim().toLowerCase();
}

function getLevel2Nodes() {
  const nodes = [];

  for (const top of subCategories) {
    const topName = String(top.label || "").trim();
    const children = Array.isArray(top.children) ? top.children : [];

    for (const child of children) {
      const secondName = String(child.label || "").trim();
      if (!secondName || secondName === "ALL") {
        continue;
      }

      nodes.push({
        topName,
        secondName,
        key: keyFor(topName, secondName),
        items: Array.isArray(child.items) ? child.items : [],
      });
    }
  }

  return nodes;
}

function buildTargets() {
  const level2Nodes = getLevel2Nodes();
  const targets = [];

  for (const node of level2Nodes) {
    if (ATTACH_MODE === "leaf") {
      for (const item of node.items) {
        const leafName = String(item || "").trim();
        if (!leafName) continue;

        targets.push({
          categorySlug: makeSlug(leafName, node.topName, node.secondName),
          specificKey: node.key,
          enumOptionsFromLevel3: node.items,
        });
      }
      continue;
    }

    targets.push({
      categorySlug: makeSlug(node.secondName, node.topName),
      specificKey: node.key,
      enumOptionsFromLevel3: node.items,
    });
  }

  return targets;
}

function resolveOptions(definition, target) {
  if (Array.isArray(definition.options)) {
    return definition.options.map((v) => String(v).trim()).filter(Boolean);
  }

  if (definition.optionsSource === "level3") {
    return (target.enumOptionsFromLevel3 || []).map((v) => String(v).trim()).filter(Boolean);
  }

  return [];
}

function mergeDefinitions(globalDefs, specificDefs, target) {
  const merged = new Map();
  const allDefs = [...globalDefs, ...specificDefs];

  for (const def of allDefs) {
    const name = String(def.name || "").trim();
    if (!name) continue;

    const key = normalize(name);
    merged.set(key, {
      name,
      type: def.type,
      isRequired: Boolean(def.isRequired),
      options: resolveOptions(def, target),
    });
  }

  return [...merged.values()];
}

async function findCategoryBySlug(slug) {
  const res = await api.get("/api/categories", {
    params: {
      "filters[slug][$eq]": slug,
      "pagination[pageSize]": 1,
    },
  });

  return res.data?.data?.[0] || null;
}

async function listCategoryAttributes(categoryId) {
  const pageSize = 200;
  let page = 1;
  const all = [];

  while (true) {
    const res = await api.get("/api/category-attributes", {
      params: {
        "filters[category][id][$eq]": categoryId,
        "pagination[page]": page,
        "pagination[pageSize]": pageSize,
      },
    });

    const items = res.data?.data || [];
    all.push(...items);

    const pagination = res.data?.meta?.pagination;
    if (!pagination || page >= pagination.pageCount) break;
    page += 1;
  }

  return all;
}

async function listAttributeOptions(attributeId) {
  const pageSize = 200;
  let page = 1;
  const all = [];

  while (true) {
    const res = await api.get("/api/category-attribute-options", {
      params: {
        "filters[category_attribute][id][$eq]": attributeId,
        "pagination[page]": page,
        "pagination[pageSize]": pageSize,
      },
    });

    const items = res.data?.data || [];
    all.push(...items);

    const pagination = res.data?.meta?.pagination;
    if (!pagination || page >= pagination.pageCount) break;
    page += 1;
  }

  return all;
}

async function createAttribute(categoryId, definition) {
  const res = await api.post(
    "/api/category-attributes",
    {
      data: {
        name: definition.name,
        type: definition.type,
        isRequired: definition.isRequired,
        category: { id: categoryId },
      },
    },
    {
      params: { status: "published" },
    }
  );

  return res.data?.data;
}

async function createOption(attributeId, value, sortOrder) {
  const res = await api.post(
    "/api/category-attribute-options",
    {
      data: {
        value,
        sortOrder,
        category_attribute: { id: attributeId },
      },
    },
    {
      params: { status: "published" },
    }
  );

  return res.data?.data;
}

async function seed() {
  console.log(`Seeding category attributes (${ATTACH_MODE})...`);
  console.time("seed-category-attributes");

  const targets = buildTargets();
  const globalDefs = Array.isArray(seedConfig.globalAttributes) ? seedConfig.globalAttributes : [];

  let createdAttributes = 0;
  let reusedAttributes = 0;
  let createdOptions = 0;
  let reusedOptions = 0;
  let missingCategories = 0;

  for (const target of targets) {
    const category = await findCategoryBySlug(target.categorySlug);
    if (!category) {
      console.warn(`Category not found for slug: ${target.categorySlug}`);
      missingCategories += 1;
      continue;
    }

    const specificDefs =
      seedConfig.categorySpecificAttributes?.[target.specificKey] || [];
    const defs = mergeDefinitions(globalDefs, specificDefs, target);

    const existingAttributes = await listCategoryAttributes(category.id);
    const attributeByName = new Map(
      existingAttributes.map((attr) => [normalize(attr.name), attr])
    );

    for (const def of defs) {
      let attr = attributeByName.get(normalize(def.name));
      if (!attr) {
        attr = await createAttribute(category.id, def);
        attributeByName.set(normalize(def.name), attr);
        createdAttributes += 1;
      } else {
        reusedAttributes += 1;
      }

      if (def.type !== "enum" || !def.options.length) continue;

      const existingOptions = await listAttributeOptions(attr.id);
      const optionByValue = new Map(
        existingOptions.map((option) => [normalize(option.value), option])
      );

      for (let i = 0; i < def.options.length; i += 1) {
        const optionValue = def.options[i];
        const optionKey = normalize(optionValue);
        if (optionByValue.has(optionKey)) {
          reusedOptions += 1;
          continue;
        }

        const created = await createOption(attr.id, optionValue, i + 1);
        optionByValue.set(optionKey, created);
        createdOptions += 1;
      }
    }
  }

  console.timeEnd("seed-category-attributes");
  console.log("Done");
  console.log({
    attachMode: ATTACH_MODE,
    createdAttributes,
    reusedAttributes,
    createdOptions,
    reusedOptions,
    missingCategories,
  });
}

seed().catch((error) => {
  const message =
    error?.response?.data?.error?.message ||
    error?.response?.data ||
    error?.message ||
    error;
  console.error("Seed failed:", message);
  process.exit(1);
});
