/**
 * product controller
 */

import { factories } from "@strapi/strapi";
import { createNotification } from "../../../lib/createNotification";

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

const conditionToLabel = (value: string): string =>
  String(value || "")
    .trim()
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();

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

const toLookupValues = (value: any): string[] => {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item ?? "").trim())
      .filter((item) => item.length > 0);
  }
  if (typeof value === "object") {
    const candidates = [
      value.id,
      value.value,
      value.slug,
      value.name,
      value.title,
    ];
    return candidates
      .map((item) => String(item ?? "").trim())
      .filter((item) => item.length > 0);
  }
  const text = String(value).trim();
  return text ? [text] : [];
};

const getFirstScalarText = (value: any): string => {
  const lookupValues = toLookupValues(value);
  return lookupValues[0] ?? "";
};

const createPublishedPav = async (strapi: any, data: Record<string, any>) => {
  if (typeof strapi?.documents === "function") {
    return strapi
      .documents("api::product-attribute-value.product-attribute-value")
      .create({
        data,
        status: "published",
      });
  }

  return strapi.entityService.create(
    "api::product-attribute-value.product-attribute-value",
    {
      data,
    },
  );
};

const extractDynamicEntries = (
  input: any,
): Array<{ code: string; rawValue: any }> => {
  if (!input) return [];

  if (Array.isArray(input)) {
    return input
      .map((row: any) => {
        if (!row || typeof row !== "object") return null;
        const code =
          row.code ??
          row.key ??
          row.attributeCode ??
          row.attribute_code ??
          row?.attribute?.code ??
          row?.attribute?.key ??
          row?.name;
        const rawValue =
          row.value ??
          row.selectedValue ??
          row.selected_value ??
          row.optionValue ??
          row.option_value ??
          row.option?.value ??
          row.option?.id ??
          row.id ??
          null;
        const normalizedCode = normalizeCode(code);
        if (!normalizedCode) return null;
        return { code: normalizedCode, rawValue };
      })
      .filter((row): row is { code: string; rawValue: any } => Boolean(row));
  }

  if (typeof input === "object") {
    return Object.entries(input)
      .map(([code, rawValue]) => ({
        code: normalizeCode(code),
        rawValue,
      }))
      .filter((row) => Boolean(row.code));
  }

  return [];
};

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
        const rawAttributeValues = (() => {
          if (body.attributeValues && typeof body.attributeValues === "object")
            return body.attributeValues;
          if (typeof body.attributeValues === "string") {
            try {
              const parsed = JSON.parse(body.attributeValues);
              if (parsed && typeof parsed === "object") return parsed;
            } catch (_) {}
          }
          if (body.attributes && typeof body.attributes === "object")
            return body.attributes;
          if (typeof body.attributes === "string") {
            try {
              const parsed = JSON.parse(body.attributes);
              if (parsed && typeof parsed === "object") return parsed;
            } catch (_) {}
          }
          return null;
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
        const dynamicEntries = [
          ...extractDynamicEntries(rawDynamicValues),
          ...extractDynamicEntries(rawAttributeValues),
        ];
        const dynamicValuesByLowerKey = new Map<string, any>(
          dynamicEntries.map(({ code, rawValue }) => [code, rawValue]),
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
          dynamicValuesByLowerKey.get("brand") ??
          dynamicValuesByLowerKey.get("brand_id") ??
          dynamicValuesByLowerKey.get("brandid") ??
          body.brand ??
          body.brandId;
        const rawSizeValue =
          dynamicValuesByLowerKey.get("size") ??
          dynamicValuesByLowerKey.get("size_id") ??
          dynamicValuesByLowerKey.get("sizeid") ??
          body.size ??
          body.sizeId;
        const rawColorValue =
          dynamicValuesByLowerKey.get("color") ??
          dynamicValuesByLowerKey.get("colour") ??
          body.color ??
          body.colour;

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
          const lookupValues = toLookupValues(rawBrandValue);
          if (lookupValues.length === 0) return null;
          const idCandidate = lookupValues
            .map((item) => Number(item))
            .find((item) => Number.isInteger(item) && item > 0) as
            | number
            | undefined;
          const textValues = lookupValues
            .map((item) => item.trim())
            .filter((item) => item.length > 0);
          const brandFilters = idCandidate
            ? { id: { $eq: idCandidate } }
            : {
                $or: [
                  {
                    slug: { $in: textValues.map((item) => item.toLowerCase()) },
                  },
                  ...textValues.map((item) => ({ name: { $eqi: item } })),
                ],
              };

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
          const lookupValues = toLookupValues(rawSizeValue);
          if (lookupValues.length === 0) return null;
          const idCandidate = lookupValues
            .map((item) => Number(item))
            .find((item) => Number.isInteger(item) && item > 0) as
            | number
            | undefined;
          const textValues = lookupValues
            .map((item) => item.trim())
            .filter((item) => item.length > 0);
          const sizeFilters = idCandidate
            ? { id: { $eq: idCandidate } }
            : {
                $or: [
                  {
                    slug: { $in: textValues.map((item) => item.toLowerCase()) },
                  },
                  ...textValues.map((item) => ({ name: { $eqi: item } })),
                ],
              };
          const sizeRows = await strapi.entityService.findMany(
            "api::size.size",
            {
              filters: sizeFilters,
              fields: ["id"],
              limit: 1,
            },
          );
          return sizeRows?.[0]?.id ? Number(sizeRows[0].id) : null;
        })();

        let colorId: number | null = null;
        const colorPromise = (async () => {
          if (rawColorValue == null || String(rawColorValue).trim() === "")
            return null;
          const asColorId = Number(rawColorValue);
          const rawColorText = String(rawColorValue).trim();
          const colorFilters =
            Number.isInteger(asColorId) && asColorId > 0
              ? { id: { $eq: asColorId } }
              : {
                  $or: [
                    { slug: { $eq: rawColorText.toLowerCase() } },
                    { name: { $eqi: rawColorText } },
                  ],
                };
          const colorRows = await strapi.entityService.findMany(
            "api::color.color",
            {
              filters: colorFilters,
              fields: ["id"],
              limit: 1,
            },
          );
          return colorRows?.[0]?.id ? Number(colorRows[0].id) : null;
        })();

        let conditionId: number | null = null;
        const conditionPromise = (async () => {
          const rawConditionText = String(conditionRawValue ?? "").trim();
          if (!rawConditionText) return null;

          const asConditionId = Number(rawConditionText);
          const normalizedCondition = normalizeCondition(rawConditionText);
          const normalizedConditionSlug = normalizedCondition
            ? conditionToLabel(normalizedCondition)
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "_")
                .replace(/^_+|_+$/g, "")
            : null;

          const conditionFilters =
            Number.isInteger(asConditionId) && asConditionId > 0
              ? { id: { $eq: asConditionId } }
              : {
                  $or: [
                    { slug: { $eq: rawConditionText.toLowerCase() } },
                    { name: { $eqi: rawConditionText } },
                    ...(normalizedConditionSlug
                      ? [
                          { slug: { $eq: normalizedConditionSlug } },
                          {
                            name: {
                              $eqi: conditionToLabel(normalizedCondition),
                            },
                          },
                        ]
                      : []),
                  ],
                };

          const conditionRows = await strapi.entityService.findMany(
            "api::condition.condition",
            {
              filters: conditionFilters,
              fields: ["id"],
              limit: 1,
            },
          );
          return conditionRows?.[0]?.id ? Number(conditionRows[0].id) : null;
        })();

        const [
          categoryRows,
          resolvedBrandId,
          resolvedSizeId,
          resolvedColorId,
          resolvedConditionId,
        ] = await Promise.all([
          categoryPromise,
          brandPromise,
          sizePromise,
          colorPromise,
          conditionPromise,
        ]);

        if (!categoryRows?.[0]) return ctx.badRequest("Invalid categoryId.");
        brandId = resolvedBrandId;
        sizeId = resolvedSizeId;
        colorId = resolvedColorId;
        conditionId = resolvedConditionId;

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
              ...(colorId ? { color: colorId } : {}),
              ...(conditionId ? { product_condition: conditionId } : {}),
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
            ({ code }) =>
              !["brand", "size", "color", "colour", "condition"].includes(
                String(code ?? "")
                  .trim()
                  .toLowerCase(),
              ),
          )
          .map(({ code, rawValue }) => ({
            code: normalizeCode(code),
            rawValue,
          }))
          .filter(
            ({ code, rawValue }) =>
              Boolean(code) && toLookupValues(rawValue).length > 0,
          );

        if (attributeEntries.length > 0) {
          const uniqueCodes = [
            ...new Set(attributeEntries.map((entry) => entry.code)),
          ];
          const categoryScopedAttributes = await strapi.entityService.findMany(
            "api::category-attribute.category-attribute",
            {
              filters: {
                category: { id: { $eq: categoryId } },
              },
              fields: ["id", "code", "name", "type"],
              limit: 1000,
            },
          );

          const attributeByCode = new Map<string, any>();
          for (const attr of categoryScopedAttributes as any[]) {
            const key = normalizeCode(attr.code || attr.name);
            if (!key) continue;
            if (!attributeByCode.has(key)) attributeByCode.set(key, attr);
          }

          const missingCodes = uniqueCodes.filter(
            (code) => !attributeByCode.has(code),
          );
          if (missingCodes.length > 0) {
            const fallbackAttributes = await strapi.entityService.findMany(
              "api::category-attribute.category-attribute",
              {
                filters: { code: { $in: missingCodes } },
                fields: ["id", "code", "name", "type"],
                limit: 1000,
              },
            );

            for (const attr of fallbackAttributes as any[]) {
              const key = normalizeCode(attr.code || attr.name);
              if (!key) continue;
              if (!attributeByCode.has(key)) attributeByCode.set(key, attr);
            }
          }

          const stillMissingCodes = uniqueCodes.filter(
            (code) => !attributeByCode.has(code),
          );
          if (stillMissingCodes.length > 0) {
            const broadFallbackAttributes = await strapi.entityService.findMany(
              "api::category-attribute.category-attribute",
              {
                fields: ["id", "code", "name", "type"],
                limit: 5000,
              },
            );
            for (const attr of broadFallbackAttributes as any[]) {
              const keyFromCode = normalizeCode(attr.code);
              const keyFromName = normalizeCode(attr.name);
              if (keyFromCode && !attributeByCode.has(keyFromCode))
                attributeByCode.set(keyFromCode, attr);
              if (keyFromName && !attributeByCode.has(keyFromName))
                attributeByCode.set(keyFromName, attr);
            }
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
          const optionIdByAttrAndId = new Map<string, number>();
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
              optionIdByAttrAndId.set(`${attrId}::${optionId}`, optionId);
            }
          }

          const pavCreatePromises: Promise<any>[] = [];
          let createdPavCount = 0;
          for (const { code, rawValue } of attributeEntries) {
            const categoryAttribute = attributeByCode.get(code);
            if (!categoryAttribute) continue;

            const valueType = String(categoryAttribute.type || "string");
            let valueText: string | null = null;
            let valueNumber: string | null = null;
            let valueBoolean: boolean | null = null;
            let optionId: number | null = null;

            if (valueType === "number") {
              const asNumber = Number(getFirstScalarText(rawValue));
              if (!Number.isFinite(asNumber)) continue;
              valueNumber = String(asNumber);
            } else if (valueType === "boolean") {
              const booleanText = getFirstScalarText(rawValue).toLowerCase();
              valueBoolean =
                booleanText === "true" ||
                booleanText === "yes" ||
                rawValue === true ||
                rawValue === 1 ||
                rawValue === "1";
            } else if (valueType === "enum") {
              const candidates = toLookupValues(rawValue);
              const selectedAttrId = Number(categoryAttribute.id);
              optionId =
                candidates
                  .map((candidate) => candidate.trim())
                  .map(
                    (candidate) =>
                      optionIdByAttrAndValue.get(
                        `${selectedAttrId}::${candidate.toLowerCase()}`,
                      ) ??
                      optionIdByAttrAndId.get(
                        `${selectedAttrId}::${Number(candidate)}`,
                      ) ??
                      null,
                  )
                  .find(
                    (candidate) => Number.isInteger(candidate) && candidate > 0,
                  ) ?? null;
              valueText = candidates[0] ? String(candidates[0]).trim() : null;
            } else {
              valueText = getFirstScalarText(rawValue);
            }

            if (
              valueText == null &&
              valueNumber == null &&
              valueBoolean == null &&
              !optionId
            ) {
              continue;
            }

            pavCreatePromises.push(
              createPublishedPav(strapi, {
                product: createdProduct.id,
                category_attribute: categoryAttribute.id,
                ...(valueText != null ? { valueText } : {}),
                ...(valueNumber != null ? { valueNumber } : {}),
                ...(valueBoolean != null ? { valueBoolean } : {}),
                ...(optionId ? { category_attribute_option: optionId } : {}),
              }).then((result: any) => {
                if (result) createdPavCount += 1;
                return result;
              }),
            );
          }

          if (pavCreatePromises.length > 0) {
            await Promise.all(pavCreatePromises);
          }

          strapi.log.info(
            `[createSellNow] product=${createdProduct.id} pav_created=${createdPavCount} entries=${attributeEntries.length}`,
          );
        }

        ctx.body = {
          ok: true,
          product: {
            id: createdProduct.id,
            title: createdProduct.title,
          },
        };

        // Fire-and-forget product_created notification
        const sellerId = body?.userId ? Number(body.userId) : null;
        if (sellerId) {
          createNotification({
            strapi,
            recipientId: sellerId,
            type: "product_created",
            title: "Product listed successfully! 👚",
            body: `"${title}" is now live on Reluv.`,
            link: `/products/${createdProduct.id}`,
          });
        }
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
            filters: { users_permissions_user: { id: { $ne: null } } },

            fields: [
              "id",
              "documentId",
              "title",
              "price",
              "condition",
              "createdAt",
            ] as any[],

            populate: [
              "category",
              "brand",
              "size",
              "color",
              "product_condition",
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
            documentId: product.documentId,
            title: product.title,
            price: product.price,
            condition: product?.product_condition?.name ?? product?.condition,
            category: product?.category?.name ?? null,
            brand: product?.brand?.name ?? null,
            size: product?.size?.name ?? null,
            color: product?.color?.name ?? null,
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
              color: { fields: ["name"] },
              product_condition: { fields: ["name"] },
              product_attribute_values: {
                fields: ["id", "valueText", "valueNumber", "valueBoolean"],
                populate: {
                  category_attribute: { fields: ["id", "code", "name"] },
                  category_attribute_option: { fields: ["id", "value"] },
                },
              },
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
            condition: product?.product_condition?.name ?? product?.condition,
            likeCount: Number(product.likeCount ?? 0) || 0,
            createdAt: product.createdAt,
            category: product?.category?.name ?? null,
            brand: product?.brand?.name ?? null,
            size: product?.size?.name ?? null,
            color: product?.color?.name ?? null,
            images: Array.isArray(product?.images)
              ? product.images.map((img: any) => ({ id: img.id, url: img.url }))
              : [],
            attributes: Array.isArray(product?.product_attribute_values)
              ? product.product_attribute_values.map((pav: any) => ({
                  id: pav?.id,
                  code: pav?.category_attribute?.code ?? null,
                  name: pav?.category_attribute?.name ?? null,
                  value:
                    pav?.category_attribute_option?.value ??
                    pav?.valueText ??
                    pav?.valueNumber ??
                    pav?.valueBoolean ??
                    null,
                }))
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
          andFilters.push({
            $or: [
              ...(normalizedCondition
                ? [{ condition: { $eq: normalizedCondition } }]
                : [{ condition: { $eqi: conditionInput } }]),
              { product_condition: { name: { $eqi: conditionInput } } },
            ],
          });
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
                color: {
                  name: { $eqi: colourInput },
                },
              },
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
              color: { fields: ["name", "slug"] },
              product_condition: { fields: ["name", "slug"] },
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
            documentId: product.documentId,
            title: product.title,
            price: product.price,
            condition: product?.product_condition?.name ?? product?.condition,
            category: product?.category?.name ?? null,
            subCategory: null,
            item: null,
            brand: product?.brand?.name ?? null,
            size: product?.size?.name ?? null,
            color:
              product?.color?.name ??
              dynamicByCode.get("colour") ??
              dynamicByCode.get("color") ??
              null,
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
    async searchProducts(ctx: any) {
      try {
        const query = ctx.query || {};
        const searchTerm = String(
          query.q || query.query || query.item || "",
        ).trim();
        const pageSize = Math.min(
          20,
          parsePositiveInt(query.pageSize ?? query.limit, 5),
        );

        if (searchTerm.length < 2) {
          ctx.body = {
            ok: true,
            products: [],
            pagination: {
              offset: 0,
              pageSize,
              hasMore: false,
            },
          };
          return;
        }

        const products = (await strapi.entityService.findMany(
          "api::product.product",
          {
            filters: {
              productStatus: { $eq: "active" },
              $or: [
                { title: { $containsi: searchTerm } },
                { brand: { name: { $containsi: searchTerm } } },
                { category: { name: { $containsi: searchTerm } } },
                { size: { name: { $containsi: searchTerm } } },
                { color: { name: { $containsi: searchTerm } } },
                { product_condition: { name: { $containsi: searchTerm } } },
              ],
            },
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
              color: { fields: ["name", "slug"] },
              product_condition: { fields: ["name", "slug"] },
              images: { fields: ["id", "url"] },
              product_attribute_values: {
                fields: ["valueText", "valueNumber", "valueBoolean"],
                populate: {
                  category_attribute: { fields: ["code"] },
                  category_attribute_option: { fields: ["value"] },
                },
              },
            },
            sort: { createdAt: "desc" as const },
            start: 0,
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
            documentId: product.documentId,
            title: product.title,
            price: product.price,
            condition: product?.product_condition?.name ?? product?.condition,
            category: product?.category?.name ?? null,
            subCategory: null,
            item: product?.title ?? null,
            brand: product?.brand?.name ?? null,
            size: product?.size?.name ?? null,
            color:
              product?.color?.name ??
              dynamicByCode.get("colour") ??
              dynamicByCode.get("color") ??
              null,
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
            offset: 0,
            pageSize,
            hasMore,
          },
        };
      } catch (error) {
        strapi.log.error(error);
        return ctx.internalServerError("Failed to search products.");
      }
    },
    async searchMembers(ctx: any) {
      try {
        const query = ctx.query || {};
        const searchTerm = String(
          query.q || query.query || query.item || "",
        ).trim();

        const pageSize = Math.min(
          20,
          parsePositiveInt(query.pageSize ?? query.limit, 5),
        );

        if (searchTerm.length < 2) {
          ctx.body = {
            ok: true,
            members: [],
            pagination: {
              offset: 0,
              pageSize,
              hasMore: false,
            },
          };
          return;
        }

        const members = await strapi.entityService.findMany(
          "plugin::users-permissions.user",
          {
            filters: {
              accountType: { $ne: "admin" },
              blocked: { $eq: false },
              $or: [
                { username: { $containsi: searchTerm } },
                { fullName: { $containsi: searchTerm } },
                { country: { $containsi: searchTerm } },
                { city: { $containsi: searchTerm } },
              ],
            },
            populate: ["avatar"], // 👈 only what you need
            sort: { createdAt: "desc" },
            start: 0,
            limit: pageSize + 1,
          },
        );
        console.log(members);

        const hasMore = members.length > pageSize;
        const pageSlice = hasMore ? members.slice(0, pageSize) : members;

        const mapped = pageSlice.map((member: any) => ({
          id: member.id,
          username: member.username,
          fullName: member.fullName,
          country: member.country,
          city: member.city,

          avatar: member.avatar
            ? {
                id: member.avatar.id,
                url: member.avatar.url,
              }
            : null,
        }));

        ctx.body = {
          ok: true,
          members: mapped,
          pagination: {
            offset: 0,
            pageSize,
            hasMore,
          },
        };
      } catch (error) {
        strapi.log.error(error);
        return ctx.internalServerError("Failed to search members.");
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
              color: { fields: ["name", "slug"] },
              product_condition: { fields: ["name", "slug"] },
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
            documentId: product.documentId,
            title: product.title,
            price: product.price,
            condition: product?.product_condition?.name ?? product?.condition,
            category: product?.category?.name ?? null,
            brand: product?.brand?.name ?? null,
            size: product?.size?.name ?? null,
            color:
              product?.color?.name ??
              dynamicByCode.get("colour") ??
              dynamicByCode.get("color") ??
              null,
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
              color: { fields: ["name"] },
              product_condition: { fields: ["name"] },
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

        const uniqueSorted = (values: string[]): string[] => {
          const seen = new Map<string, string>();
          for (const rawValue of values) {
            const value = String(rawValue || "")
              .trim()
              .replace(/\s+/g, " ");
            if (!value) continue;
            const key = value.toLowerCase();
            if (!seen.has(key)) seen.set(key, value);
          }
          return Array.from(seen.values()).sort((a, b) =>
            a.localeCompare(b, undefined, { sensitivity: "base" }),
          );
        };

        const brands = uniqueSorted(products.map((p) => p?.brand?.name));
        const sizes = uniqueSorted(products.map((p) => p?.size?.name));
        const conditions = uniqueSorted(
          products.map((p) =>
            conditionToLabel(
              String(
                p?.product_condition?.name ??
                  conditionToLabel(String(p?.condition || "")),
              ),
            ),
          ),
        );

        const colors: string[] = [];
        const materials: string[] = [];
        for (const product of products) {
          const relationColor = String(product?.color?.name ?? "").trim();
          if (relationColor) colors.push(relationColor);

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

        const normalizedColors = uniqueSorted(colors);

        ctx.body = {
          ok: true,
          options: {
            brand: brands,
            size: sizes,
            condition: conditions,
            colour: normalizedColors,
            color: normalizedColors,
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
        // ── 1. Users & Sellers ──────────────────────────────────────────
        const allUsers = await strapi.entityService.findMany(
          "plugin::users-permissions.user",
          {
            populate: { products: true },
          },
        );

        const totalUsers = allUsers.length;
        const totalSellers = allUsers.filter(
          (user: any) => user?.products?.length > 0,
        ).length;

        // ── 2. Orders ───────────────────────────────────────────────────
        const allOrders = await strapi.entityService.findMany(
          "api::order.order",
          {
            populate: {
              buyer: true, // relation → users-permissions.user
              seller: true, // relation → users-permissions.user
              product: true, // relation → api::product.product
            },
            sort: { createdAt: "desc" },
          },
        );

        let totalRevenue = 0;
        let pendingPayout = 0;
        let activeDisputes = 0;

        allOrders.forEach((order: any) => {
          totalRevenue += order.totalAmount ?? 0;
          if (order.paymentStatus === "pending")
            pendingPayout += order.totalAmount ?? 0;
          if (order.disputeStatus === "active") activeDisputes += 1;
        });

        // ── 3. Pending Payouts ──────────────────────────────────────────
        const pendingPayoutOrders = await strapi.entityService.findMany(
          "api::order.order",
          {
            filters: { paymentStatus: { $eq: "pending" } },
            populate: { seller: true },
            sort: { createdAt: "desc" },
            limit: 5,
          },
        );

        // Group pending payouts by seller
        const payoutMap = new Map<string, { name: string; amount: number }>();
        pendingPayoutOrders.forEach((order: any) => {
          const sellerName: string =
            order?.seller?.username ?? order?.seller?.email ?? "Unknown Seller";
          const existing = payoutMap.get(sellerName);
          if (existing) {
            existing.amount += order.totalAmount ?? 0;
          } else {
            payoutMap.set(sellerName, {
              name: sellerName,
              amount: order.totalAmount ?? 0,
            });
          }
        });

        const payouts = Array.from(payoutMap.values()).map((p) => ({
          name: p.name,
          amount: `€${p.amount.toLocaleString()}`,
        }));

        // ── 4. Shape recent orders for the table ────────────────────────
        const recentOrders = allOrders.slice(0, 10).map((order: any) => ({
          id: `${order.id}`,
          buyer: order?.buyer?.username ?? order?.buyer?.email ?? "Unknown",
          amount: `€${(order.totalAmount ?? 0).toLocaleString()}`,
          status: order.paymentStatus ?? "Unknown",
        }));

        // ── 5. Stats cards ──────────────────────────────────────────────
        const stats = [
          {
            label: "Total Users",
            value: totalUsers.toLocaleString(),
            color: "text-[#007782]",
          },
          {
            label: "Total Sellers",
            value: totalSellers.toLocaleString(),
            color: "text-[#1156be]",
          },
          {
            label: "Total Orders",
            value: allOrders.length.toLocaleString(),
            color: "text-slate-800",
          },
          {
            label: "Pending Payouts",
            value: `€${pendingPayout.toLocaleString()}`,
            color: "text-green-600",
          },
          {
            label: "Active Disputes",
            value: activeDisputes.toLocaleString(),
            color: "text-slate-800",
          },
          {
            label: "Revenue",
            value: `€${totalRevenue.toLocaleString()}`,
            color: "text-[#007782]",
          },
        ];

        ctx.body = {
          ok: true,
          data: { stats, orders: recentOrders, payouts },
        };
      } catch (error) {
        strapi.log.error(error);
        return ctx.internalServerError("Failed to load dashboard data.");
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
          data: users,
        };
      } catch (error) {
        strapi.log.error(error);
        return ctx.internalServerError(
          "Failed to load product filter options.",
        );
      }
    },

    async deleteMyProduct(ctx: any) {
      try {
        const userId = ctx.state?.user?.id;
        if (!userId) return ctx.unauthorized("Authentication required.");

        const id = Number(ctx.params?.id);
        if (!id) return ctx.badRequest("Product id is required.");

        const product = await strapi.db.query("api::product.product").findOne({
          where: { id },
          populate: ["users_permissions_user"],
        });

        if (!product) return ctx.notFound("Product not found.");
        if (product.users_permissions_user?.id !== userId)
          return ctx.forbidden("You can only delete your own products.");

        await strapi.db.query("api::product.product").delete({ where: { id } });

        ctx.body = { ok: true };
      } catch (error) {
        strapi.log.error(error);
        return ctx.internalServerError("Failed to delete product.");
      }
    },
  }),
);
