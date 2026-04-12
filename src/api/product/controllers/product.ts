/**
 * product controller
 */

import { factories } from "@strapi/strapi";

type ConditionValue =
  | "new_with_tags"
  | "new_without_tags"
  | "very_good"
  | "good"
  | "satisfactory";

const CONDITION_VALUES = new Set([
  "new_with_tags",
  "new_without_tags",
  "very_good",
  "good",
  "satisfactory",
]);

const normalizeCondition = (value: any): ConditionValue | null => {
  if (value == null) return null;
  const normalized = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (CONDITION_VALUES.has(normalized)) return normalized as ConditionValue;
  if (normalized === "new") return "new_without_tags" as ConditionValue;
  return null;
};

const toBlocks = (value: any): any => {
  const text = String(value ?? "").trim();
  return [
    {
      type: "paragraph",
      children: [
        {
          type: "text",
          text,
        },
      ],
    },
  ];
};

const blocksToText = (value: any): string => {
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const block of value) {
    if (!block || !Array.isArray(block.children)) continue;
    for (const child of block.children) {
      if (typeof child?.text === "string" && child.text.trim().length > 0) {
        parts.push(child.text.trim());
      }
    }
  }
  return parts.join(" ").trim();
};

const parseNumberOrNull = (value: any): number | null => {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const parsePositiveInt = (value: any, fallback: number): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const normalizeSort = (value: any): "newest" | "price_asc" | "price_desc" => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "price: low to high" || normalized === "price_asc")
    return "price_asc";
  if (normalized === "price: high to low" || normalized === "price_desc")
    return "price_desc";
  return "newest";
};

const normalizeCode = (value: any): string =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

let categorySchemaPromise: Promise<any> | null = null;

const getCategorySchema = async (strapi: any) => {
  if (categorySchemaPromise) return categorySchemaPromise;

  categorySchemaPromise = (async () => {
    const columnRows = await strapi.db
      .connection("information_schema.columns")
      .select("column_name")
      .where({ table_name: "categories" });

    const columns = new Set(columnRows.map((row: any) => row.column_name));
    const parentColumn = columns.has("category_id")
      ? "category_id"
      : columns.has("categoryId")
        ? "categoryId"
        : null;

    if (parentColumn) {
      return {
        mode: "direct",
        parentColumn,
      };
    }

    const linkRows = await strapi.db
      .connection("information_schema.columns")
      .select("table_name", "column_name")
      .where("table_name", "like", "categories%lnk");

    const byTable = new Map<string, string[]>();
    for (const row of linkRows as any[]) {
      const tableName = String(row.table_name);
      const cols = byTable.get(tableName) ?? [];
      cols.push(String(row.column_name));
      byTable.set(tableName, cols);
    }

    for (const [tableName, tableColumns] of byTable) {
      const categoryCols = tableColumns.filter(
        (c) => c.toLowerCase().includes("category") && c.endsWith("_id"),
      );
      if (categoryCols.length >= 2) {
        const invCol = categoryCols.find((c) =>
          c.toLowerCase().includes("inv_"),
        );
        const childColumn = invCol
          ? (categoryCols.find((c) => c !== invCol) ?? null)
          : categoryCols[0];
        const parentColumn = invCol ?? categoryCols[1];

        if (childColumn && parentColumn) {
          return {
            mode: "link",
            linkTable: tableName,
            childColumn,
            parentColumn,
          };
        }
      }
    }

    return {
      mode: "direct",
      parentColumn: null,
    };
  })();

  return categorySchemaPromise;
};

const getCategoryIdsWithDescendants = async (
  strapi: any,
  categoryInput: string,
): Promise<number[]> => {
  const input = String(categoryInput || "").trim();
  if (!input) return [];

  const categories = (await strapi.entityService.findMany(
    "api::category.category",
    {
      filters: {
        $or: [{ slug: { $eqi: input } }, { name: { $eqi: input } }],
      },
      fields: ["id"],
      limit: 1,
    },
  )) as any[];

  const rootId = categories?.[0]?.id ? Number(categories[0].id) : null;
  if (!Number.isInteger(rootId) || rootId <= 0) return [];

  let schema: any = null;
  try {
    schema = await getCategorySchema(strapi);
  } catch (_) {
    schema = null;
  }

  if (!schema || (schema.mode === "direct" && !schema.parentColumn)) {
    return [rootId];
  }

  const seen = new Set<number>([rootId]);
  let frontier = [rootId];

  while (frontier.length > 0) {
    const next: number[] = [];

    if (schema.mode === "direct") {
      const rows = await strapi.db
        .connection("categories")
        .select({ id: "id" }, { parentId: schema.parentColumn })
        .whereIn(schema.parentColumn, frontier);

      for (const row of rows as any[]) {
        const childId = Number(row.id);
        if (Number.isInteger(childId) && childId > 0 && !seen.has(childId)) {
          seen.add(childId);
          next.push(childId);
        }
      }
    } else {
      const rows = await strapi.db
        .connection(schema.linkTable)
        .select(
          { childId: schema.childColumn },
          { parentId: schema.parentColumn },
        )
        .whereIn(schema.parentColumn, frontier);

      for (const row of rows as any[]) {
        const childId = Number(row.childId);
        if (Number.isInteger(childId) && childId > 0 && !seen.has(childId)) {
          seen.add(childId);
          next.push(childId);
        }
      }
    }

    frontier = next;
  }

  return Array.from(seen);
};

export default factories.createCoreController(
  "api::product.product",
  ({ strapi }) => ({
    async createSellNow(ctx: any) {
      try {
        const body = ctx.request.body || {};
        const title = String(body.title || "").trim();
        const description = String(body.description || "").trim();
        const priceNumber = Number(body.price);
        const categoryId = Number(body.categoryId);
        const rawDynamicValues = (() => {
          if (body.dynamicValues && typeof body.dynamicValues === "object")
            return body.dynamicValues;
          if (typeof body.dynamicValues === "string") {
            try {
              const parsed = JSON.parse(body.dynamicValues);
              if (parsed && typeof parsed === "object") return parsed;
            } catch (_) {}
          }
          return {};
        })();
        const imageIds = (() => {
          const rawImageIds = body.imageIds;
          if (Array.isArray(rawImageIds)) {
            return [
              ...new Set(
                rawImageIds
                  .map((v: any) => Number(v))
                  .filter((v: any) => Number.isInteger(v) && v > 0),
              ),
            ];
          }
          if (typeof rawImageIds === "string") {
            try {
              const parsed = JSON.parse(rawImageIds);
              if (Array.isArray(parsed)) {
                return [
                  ...new Set(
                    parsed
                      .map((v: any) => Number(v))
                      .filter((v: any) => Number.isInteger(v) && v > 0),
                  ),
                ];
              }
            } catch (_) {}
          }
          return [] as number[];
        })();
        const dynamicEntries = Object.entries(
          rawDynamicValues as Record<string, any>,
        );
        const dynamicValuesByLowerKey = new Map<string, any>(
          dynamicEntries.map(([key, value]) => [
            String(key).trim().toLowerCase(),
            value,
          ]),
        );

        if (!title) return ctx.badRequest("title is required.");
        if (!description) return ctx.badRequest("description is required.");
        if (!Number.isFinite(priceNumber) || priceNumber <= 0)
          return ctx.badRequest("price must be > 0.");
        if (!Number.isInteger(categoryId) || categoryId <= 0)
          return ctx.badRequest("categoryId is required.");

        const conditionRawValue =
          dynamicValuesByLowerKey.get("condition") ?? body.condition;
        const condition = normalizeCondition(conditionRawValue);
        if (!condition) {
          return ctx.badRequest(
            "condition is required and must match product enum values.",
          );
        }

        const rawBrandValue =
          dynamicValuesByLowerKey.get("brand") ?? body.brand;
        const rawSizeValue = dynamicValuesByLowerKey.get("size") ?? body.size;

        const categoryPromise = strapi.entityService.findMany(
          "api::category.category",
          {
            filters: { id: { $eq: categoryId } },
            fields: ["id"],
            limit: 1,
          },
        );

        let brandId: number | null = null;
        const brandPromise = (async () => {
          if (rawBrandValue == null || String(rawBrandValue).trim() === "")
            return null;
          const asBrandId = Number(rawBrandValue);
          const brandFilters =
            Number.isInteger(asBrandId) && asBrandId > 0
              ? { id: { $eq: asBrandId } }
              : { slug: { $eq: String(rawBrandValue).trim().toLowerCase() } };

          const brandRows = await strapi.entityService.findMany(
            "api::brand.brand",
            {
              filters: brandFilters,
              fields: ["id"],
              limit: 1,
            },
          );
          return brandRows?.[0]?.id ? Number(brandRows[0].id) : null;
        })();

        let sizeId: number | null = null;
        const sizePromise = (async () => {
          if (rawSizeValue == null || String(rawSizeValue).trim() === "")
            return null;
          const asSizeId = Number(rawSizeValue);
          if (!Number.isInteger(asSizeId) || asSizeId <= 0) return null;
          const sizeRows = await strapi.entityService.findMany(
            "api::size.size",
            {
              filters: { id: { $eq: asSizeId } },
              fields: ["id"],
              limit: 1,
            },
          );
          return sizeRows?.[0]?.id ? Number(sizeRows[0].id) : null;
        })();

        const [categoryRows, resolvedBrandId, resolvedSizeId] =
          await Promise.all([categoryPromise, brandPromise, sizePromise]);

        if (!categoryRows?.[0]) return ctx.badRequest("Invalid categoryId.");
        brandId = resolvedBrandId;
        sizeId = resolvedSizeId;

        const createdProduct = await strapi.db
          .query("api::product.product")
          .create({
            data: {
              title,
              description: toBlocks(description),
              condition,
              productStatus: "active",
              price: String(priceNumber),
              category: categoryId,
              users_permissions_user: body?.userId ? Number(body.userId) : null,
              ...(brandId ? { brand: brandId } : {}),
              ...(sizeId ? { size: sizeId } : {}),
            },
          });

        if (imageIds.length > 0) {
          await strapi.db.query("api::product.product").update({
            where: { id: createdProduct.id },
            data: { images: imageIds },
          });
        }

        const attributeEntries = dynamicEntries
          .filter(
            ([code]) =>
              !["brand", "size", "condition"].includes(
                String(code).trim().toLowerCase(),
              ),
          )
          .map(([code, rawValue]) => ({ code: String(code), rawValue }))
          .filter(
            ({ rawValue }) =>
              rawValue != null && String(rawValue).trim() !== "",
          );

        if (attributeEntries.length > 0) {
          const uniqueCodes = [
            ...new Set(attributeEntries.map((entry) => entry.code)),
          ];
          const categoryAttributes = await strapi.entityService.findMany(
            "api::category-attribute.category-attribute",
            {
              filters: { code: { $in: uniqueCodes } },
              fields: ["id", "code", "type"],
              limit: 1000,
            },
          );

          const attributeByCode = new Map<string, any>();
          for (const attr of categoryAttributes as any[]) {
            const code = String(attr.code || "").trim();
            if (!code) continue;
            if (!attributeByCode.has(code)) attributeByCode.set(code, attr);
          }

          const enumAttributeIds = [
            ...new Set(
              attributeEntries
                .map(({ code }) => attributeByCode.get(code))
                .filter((attr) => attr && String(attr.type) === "enum")
                .map((attr) => Number(attr.id))
                .filter((id) => Number.isInteger(id) && id > 0),
            ),
          ];

          const optionIdByAttrAndValue = new Map<string, number>();
          if (enumAttributeIds.length > 0) {
            const enumOptions = await strapi.entityService.findMany(
              "api::category-attribute-option.category-attribute-option",
              {
                filters: {
                  category_attribute: { id: { $in: enumAttributeIds } },
                },
                fields: ["id", "value"],
                populate: {
                  category_attribute: {
                    fields: ["id"],
                  },
                },
                limit: 5000,
              },
            );

            for (const option of enumOptions as any[]) {
              const attrId = Number(option?.category_attribute?.id);
              const value = String(option?.value ?? "")
                .trim()
                .toLowerCase();
              const optionId = Number(option?.id);
              if (
                !Number.isInteger(attrId) ||
                !value ||
                !Number.isInteger(optionId)
              )
                continue;
              optionIdByAttrAndValue.set(`${attrId}::${value}`, optionId);
            }
          }

          const pavCreatePromises: Promise<any>[] = [];
          for (const { code, rawValue } of attributeEntries) {
            const categoryAttribute = attributeByCode.get(code);
            if (!categoryAttribute) continue;

            const valueType = String(categoryAttribute.type || "string");
            let valueText: string | null = null;
            let valueNumber: string | null = null;
            let valueBoolean: boolean | null = null;
            let optionId: number | null = null;

            if (valueType === "number") {
              const asNumber = Number(rawValue);
              if (!Number.isFinite(asNumber)) continue;
              valueNumber = String(asNumber);
            } else if (valueType === "boolean") {
              valueBoolean =
                String(rawValue).toLowerCase() === "true" ||
                rawValue === true ||
                rawValue === 1 ||
                rawValue === "1";
            } else if (valueType === "enum") {
              const rawText = String(rawValue).trim();
              valueText = rawText;
              optionId =
                optionIdByAttrAndValue.get(
                  `${Number(categoryAttribute.id)}::${rawText.toLowerCase()}`,
                ) ?? null;
            } else {
              valueText = String(rawValue).trim();
            }

            pavCreatePromises.push(
              strapi.db
                .query("api::product-attribute-value.product-attribute-value")
                .create({
                  data: {
                    product: createdProduct.id,
                    category_attribute: categoryAttribute.id,
                    ...(valueText != null ? { valueText } : {}),
                    ...(valueNumber != null ? { valueNumber } : {}),
                    ...(valueBoolean != null ? { valueBoolean } : {}),
                    ...(optionId
                      ? { category_attribute_option: optionId }
                      : {}),
                  },
                }),
            );
          }

          if (pavCreatePromises.length > 0) {
            await Promise.all(pavCreatePromises);
          }
        }

        ctx.body = {
          ok: true,
          product: {
            id: createdProduct.id,
            title: createdProduct.title,
          },
        };
      } catch (error) {
        strapi.log.error(error);
        return ctx.internalServerError("Failed to create product.");
      }
    },
    async getProducts(ctx: any) {
      try {
        const query = ctx.query || {};
        const products = (await strapi.entityService.findMany(
          "api::product.product",
          {
            fields: ["id", "title", "price", "condition", "createdAt"],
            populate: [
              "category",
              "brand",
              "size",
              "images",
              "users_permissions_user",
            ],
            sort: { createdAt: "desc" },
            limit: 20,
            offset: query?.offset ? Number(query?.offset) : 0,
          },
        )) as any[];

        ctx.body = {
          ok: true,
          products: products.map((product: any) => ({
            id: product.id,
            title: product.title,
            price: product.price,
            condition: product?.condition,
            category: product?.category?.name ?? null,
            brand: product?.brand?.name ?? null,
            size: product?.size?.name ?? null,
            images: Array.isArray(product.images)
              ? product.images.map((img: any) => ({ id: img.id, url: img.url }))
              : [],
            userId: product?.users_permissions_user ?? null,
          })),
        };
      } catch (error) {
        strapi.log.error(error);
        return ctx.internalServerError("Failed to fetch products.");
      }
    },
    async getProductById(ctx: any) {
      try {
        const id = Number(ctx.params?.id);
        if (!Number.isInteger(id) || id <= 0) {
          return ctx.badRequest("A valid product id is required.");
        }

        const productData = (await strapi.entityService.findMany(
          "api::product.product",
          {
            filters: { id: { $eq: id } },
            fields: [
              "id",
              "title",
              "price",
              "condition",
              "likeCount",
              "createdAt",
              "description",
            ],
            populate: {
              category: { fields: ["name"] },
              brand: { fields: ["name"] },
              size: { fields: ["name"] },
              images: { fields: ["id", "url"] },
              users_permissions_user: {
                fields: ["id", "username", "rating_avg", "city", "country"],
              },
            },
            limit: 1,
          },
        )) as any[];

        const product = productData?.[0] as any;
        if (!product) {
          return ctx.notFound("Product not found.");
        }

        ctx.body = {
          ok: true,
          product: {
            id: product.id,
            title: product.title,
            description: blocksToText(product.description),
            price: product.price,
            condition: product.condition,
            likeCount: Number(product.likeCount ?? 0) || 0,
            createdAt: product.createdAt,
            category: product?.category?.name ?? null,
            brand: product?.brand?.name ?? null,
            size: product?.size?.name ?? null,
            images: Array.isArray(product?.images)
              ? product.images.map((img: any) => ({ id: img.id, url: img.url }))
              : [],
            user: product?.users_permissions_user,
          },
        };
      } catch (error) {
        strapi.log.error(error);
        return ctx.internalServerError("Failed to fetch product details.");
      }
    },
    async filterProducts(ctx: any) {
      try {
        const query = ctx.query || {};
        const offset = Math.max(
          0,
          Number(
            query.offset ||
              (Number(query.page || 1) - 1) * Number(query.pageSize || 20) ||
              0,
          ),
        );
        const pageSize = Math.min(
          100,
          parsePositiveInt(query.pageSize ?? query.limit, 20),
        );
        const categoryInput = String(
          query.item || query.subCategory || query.category || "",
        ).trim();
        const brandInput = String(query.brand || "").trim();
        const sizeInput = String(query.size || "").trim();
        const conditionInput = String(query.condition || "").trim();
        const colourInput = String(query.colour || query.color || "").trim();
        const materialInput = String(query.material || "").trim();
        const minPrice = parseNumberOrNull(query.minPrice);
        const maxPrice = parseNumberOrNull(query.maxPrice);
        const sortBy = normalizeSort(query.sortBy || query.sort);

        const filters: any = {
          productStatus: { $eq: "active" },
        };
        const andFilters: any[] = [];

        if (categoryInput) {
          const categoryIds = await getCategoryIdsWithDescendants(
            strapi,
            categoryInput,
          );
          if (categoryIds.length > 0) {
            andFilters.push({
              category: { id: { $in: categoryIds } },
            });
          } else {
            andFilters.push({
              category: {
                $or: [
                  { slug: { $eqi: categoryInput } },
                  { name: { $eqi: categoryInput } },
                  { name: { $containsi: categoryInput } },
                ],
              },
            });
          }
        }

        if (brandInput) {
          andFilters.push({
            brand: { name: { $eqi: brandInput } },
          });
        }

        if (sizeInput) {
          andFilters.push({
            size: { name: { $eqi: sizeInput } },
          });
        }

        if (conditionInput) {
          const normalizedCondition = normalizeCondition(conditionInput);
          if (normalizedCondition) {
            andFilters.push({ condition: { $eq: normalizedCondition } });
          } else {
            andFilters.push({ condition: { $eqi: conditionInput } });
          }
        }

        if (minPrice != null || maxPrice != null) {
          const priceRange: any = {};
          if (minPrice != null) priceRange.$gte = minPrice;
          if (maxPrice != null) priceRange.$lte = maxPrice;
          andFilters.push({ price: priceRange });
        }

        if (colourInput) {
          andFilters.push({
            $or: [
              {
                product_attribute_values: {
                  category_attribute: {
                    code: { $eqi: "colour" },
                  },
                  valueText: { $eqi: colourInput },
                },
              },
              {
                product_attribute_values: {
                  category_attribute: {
                    code: { $eqi: "color" },
                  },
                  valueText: { $eqi: colourInput },
                },
              },
              {
                product_attribute_values: {
                  category_attribute: {
                    code: { $eqi: "colour" },
                  },
                  category_attribute_option: {
                    value: { $eqi: colourInput },
                  },
                },
              },
              {
                product_attribute_values: {
                  category_attribute: {
                    code: { $eqi: "color" },
                  },
                  category_attribute_option: {
                    value: { $eqi: colourInput },
                  },
                },
              },
            ],
          });
        }

        if (materialInput) {
          andFilters.push({
            $or: [
              {
                product_attribute_values: {
                  category_attribute: {
                    code: { $eqi: "material" },
                  },
                  valueText: { $eqi: materialInput },
                },
              },
              {
                product_attribute_values: {
                  category_attribute: {
                    code: { $eqi: "material" },
                  },
                  category_attribute_option: {
                    value: { $eqi: materialInput },
                  },
                },
              },
            ],
          });
        }

        if (andFilters.length > 0) {
          filters.$and = andFilters;
        }

        const sort =
          sortBy === "price_asc"
            ? { price: "asc" as const }
            : sortBy === "price_desc"
              ? { price: "desc" as const }
              : { createdAt: "desc" as const };

        const products = (await strapi.entityService.findMany(
          "api::product.product",
          {
            filters,
            fields: [
              "id",
              "title",
              "price",
              "condition",
              "createdAt",
              "likeCount",
            ],
            populate: {
              category: { fields: ["name", "slug"] },
              brand: { fields: ["name", "slug"] },
              size: { fields: ["name"] },
              images: { fields: ["id", "url"] },
              product_attribute_values: {
                fields: ["valueText", "valueNumber", "valueBoolean"],
                populate: {
                  category_attribute: { fields: ["code"] },
                  category_attribute_option: { fields: ["value"] },
                },
              },
            },
            sort,
            start: offset,
            limit: pageSize + 1,
          },
        )) as any[];

        const hasMore = products.length > pageSize;
        const pageSlice = hasMore ? products.slice(0, pageSize) : products;

        const mapped = pageSlice.map((product: any) => {
          const dynamicByCode = new Map<string, string>();
          const pavs = Array.isArray(product?.product_attribute_values)
            ? product.product_attribute_values
            : [];
          for (const pav of pavs) {
            const code = normalizeCode(pav?.category_attribute?.code);
            if (!code) continue;
            const textValue = String(
              pav?.category_attribute_option?.value ??
                pav?.valueText ??
                pav?.valueNumber ??
                pav?.valueBoolean ??
                "",
            ).trim();
            if (!textValue) continue;
            if (!dynamicByCode.has(code)) dynamicByCode.set(code, textValue);
          }

          return {
            id: product.id,
            title: product.title,
            price: product.price,
            condition: product?.condition,
            category: product?.category?.name ?? null,
            subCategory: null,
            item: null,
            brand: product?.brand?.name ?? null,
            size: product?.size?.name ?? null,
            color:
              dynamicByCode.get("colour") || dynamicByCode.get("color") || null,
            material: dynamicByCode.get("material") || null,
            likeCount: Number(product?.likeCount ?? 0) || 0,
            images: Array.isArray(product.images)
              ? product.images.map((img: any) => ({ id: img.id, url: img.url }))
              : [],
          };
        });

        ctx.body = {
          ok: true,
          products: mapped,
          pagination: {
            offset,
            pageSize,
            hasMore,
          },
        };
      } catch (error) {
        strapi.log.error(error);
        return ctx.internalServerError("Failed to fetch filtered products.");
      }
    },
    async getProductsByUserId(ctx: any) {
      try {
        const userId = Number(ctx.params?.userId);
        if (!Number.isInteger(userId) || userId <= 0) {
          return ctx.badRequest("A valid user ID is required.");
        }

        const products = (await strapi.entityService.findMany(
          "api::product.product",
          {
            filters: {
              users_permissions_user: { id: { $eq: userId } },
            },
            fields: [
              "id",
              "title",
              "price",
              "condition",
              "likeCount",
              "createdAt",
            ],
            populate: {
              category: { fields: ["name", "slug"] },
              brand: { fields: ["name", "slug"] },
              size: { fields: ["name"] },
              images: { fields: ["id", "url"] },
              product_attribute_values: {
                fields: ["valueText", "valueNumber", "valueBoolean"],
                populate: {
                  category_attribute: { fields: ["code"] },
                  category_attribute_option: { fields: ["value"] },
                },
              },
            },
            sort: { createdAt: "desc" },
            limit: 100,
          },
        )) as any[];

        const mapped = products.map((product: any) => {
          const dynamicByCode = new Map<string, string>();
          const pavs = Array.isArray(product?.product_attribute_values)
            ? product.product_attribute_values
            : [];
          for (const pav of pavs) {
            const code = normalizeCode(pav?.category_attribute?.code);
            if (!code) continue;
            const textValue = String(
              pav?.category_attribute_option?.value ??
                pav?.valueText ??
                pav?.valueNumber ??
                pav?.valueBoolean ??
                "",
            ).trim();
            if (!textValue) continue;
            if (!dynamicByCode.has(code)) dynamicByCode.set(code, textValue);
          }

          return {
            id: product.id,
            title: product.title,
            price: product.price,
            condition: product?.condition,
            category: product?.category?.name ?? null,
            brand: product?.brand?.name ?? null,
            size: product?.size?.name ?? null,
            color:
              dynamicByCode.get("colour") || dynamicByCode.get("color") || null,
            material: dynamicByCode.get("material") || null,
            likeCount: Number(product?.likeCount ?? 0) || 0,
            images: Array.isArray(product.images)
              ? product.images.map((img: any) => ({ id: img.id, url: img.url }))
              : [],
          };
        });

        ctx.body = {
          ok: true,
          products: mapped,
        };
      } catch (error) {
        strapi.log.error(error);
        return ctx.internalServerError("Failed to fetch user products.");
      }
    },
    async getFilterOptions(ctx: any) {
      try {
        const query = ctx.query || {};
        const categoryInput = String(
          query.item || query.subCategory || query.category || "",
        ).trim();

        const filters: any = {
          productStatus: { $eq: "active" },
        };

        if (categoryInput) {
          const categoryIds = await getCategoryIdsWithDescendants(
            strapi,
            categoryInput,
          );
          if (categoryIds.length > 0) {
            filters.$and = [
              {
                category: { id: { $in: categoryIds } },
              },
            ];
          } else {
            filters.$and = [
              {
                category: {
                  $or: [
                    { slug: { $eqi: categoryInput } },
                    { name: { $eqi: categoryInput } },
                    { name: { $containsi: categoryInput } },
                  ],
                },
              },
            ];
          }
        }

        const products = (await strapi.entityService.findMany(
          "api::product.product",
          {
            filters,
            fields: ["id", "condition"],
            populate: {
              brand: { fields: ["name"] },
              size: { fields: ["name"] },
              product_attribute_values: {
                fields: ["valueText"],
                populate: {
                  category_attribute: { fields: ["code"] },
                  category_attribute_option: { fields: ["value"] },
                },
              },
            },
            limit: 5000,
          },
        )) as any[];

        const uniqueSorted = (values: string[]): string[] =>
          [
            ...new Set(
              values.map((v) => String(v || "").trim()).filter(Boolean),
            ),
          ].sort((a, b) => a.localeCompare(b));

        const brands = uniqueSorted(products.map((p) => p?.brand?.name));
        const sizes = uniqueSorted(products.map((p) => p?.size?.name));
        const conditions = uniqueSorted(
          products.map((p) => String(p?.condition || "").replace(/_/g, " ")),
        );

        const colors: string[] = [];
        const materials: string[] = [];
        for (const product of products) {
          const pavs = Array.isArray(product?.product_attribute_values)
            ? product.product_attribute_values
            : [];
          for (const pav of pavs) {
            const code = normalizeCode(pav?.category_attribute?.code);
            const value = String(
              pav?.category_attribute_option?.value ?? pav?.valueText ?? "",
            ).trim();
            if (!value) continue;
            if (code === "color" || code === "colour") colors.push(value);
            if (code === "material") materials.push(value);
          }
        }

        ctx.body = {
          ok: true,
          options: {
            brand: brands,
            size: sizes,
            condition: conditions,
            colour: uniqueSorted(colors),
            material: uniqueSorted(materials),
            sortBy: ["Newest", "Price: Low to high", "Price: High to low"],
          },
        };
      } catch (error) {
        strapi.log.error(error);
        return ctx.internalServerError(
          "Failed to load product filter options.",
        );
      }
    },
    async getDashboardData(ctx: any) {
      try {
        const query = ctx.query || {};
        const usersCount = await strapi.entityService.count(
          "plugin::users-permissions.user",
        );
        // const totalOrders = await strapi.entityService.count(
        //   "plugin::users-permissions.user",
        // );
        const sellersUsersCount = await strapi.entityService.count(
          "plugin::users-permissions.user",
          {
            filters: {
              accountType: { $eq: "user" },
            },
          },
        );
        console.log(
          "Retrieved users:",
          usersCount,
          "sellersUsersCount",
          sellersUsersCount,
        );
        ctx.body = {
          ok: true,
          data: {
            stats: [],
            orders: [],
            payouts: [],
          },
        };
      } catch (error) {
        strapi.log.error(error);
        return ctx.internalServerError(
          "Failed to load product filter options.",
        );
      }
    },
    async getAllUsers(ctx: any) {
      try {
        const query = ctx.query || {};
        const users = await strapi.entityService.findMany(
          "plugin::users-permissions.user",
          {
            populate: "*",
            start: 0,
            limit: 100,
          },
        );
        ctx.body = {
          ok: true,
          data:users
        };
      } catch (error) {
        strapi.log.error(error);
        return ctx.internalServerError(
          "Failed to load product filter options.",
        );
      }
    },
  }),
);
