/**
 * product controller
 */

import { factories } from '@strapi/strapi';

type ConditionValue =
  | 'new_with_tags'
  | 'new_without_tags'
  | 'very_good'
  | 'good'
  | 'satisfactory';

const CONDITION_VALUES = new Set([
  'new_with_tags',
  'new_without_tags',
  'very_good',
  'good',
  'satisfactory',
]);

const normalizeCondition = (value: any): ConditionValue | null => {
  if (value == null) return null;
  const normalized = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (CONDITION_VALUES.has(normalized)) return normalized as ConditionValue;
  if (normalized === 'new') return 'new_without_tags' as ConditionValue;
  return null;
};

const toBlocks = (value: any): any => {
  const text = String(value ?? '').trim();
  return [
    {
      type: 'paragraph',
      children: [
        {
          type: 'text',
          text,
        },
      ],
    },
  ];
};

const blocksToText = (value: any): string => {
  if (!Array.isArray(value)) return '';
  const parts: string[] = [];
  for (const block of value) {
    if (!block || !Array.isArray(block.children)) continue;
    for (const child of block.children) {
      if (typeof child?.text === 'string' && child.text.trim().length > 0) {
        parts.push(child.text.trim());
      }
    }
  }
  return parts.join(' ').trim();
};

export default factories.createCoreController('api::product.product', ({ strapi }) => ({
  async createSellNow(ctx: any) {
    try {
      const body = ctx.request.body || {};
      const title = String(body.title || '').trim();
      const description = String(body.description || '').trim();
      const priceNumber = Number(body.price);
      const categoryId = Number(body.categoryId);
      const rawDynamicValues = (() => {
        if (body.dynamicValues && typeof body.dynamicValues === 'object') return body.dynamicValues;
        if (typeof body.dynamicValues === 'string') {
          try {
            const parsed = JSON.parse(body.dynamicValues);
            if (parsed && typeof parsed === 'object') return parsed;
          } catch (_) {}
        }
        return {};
      })();
      const imageIds = (() => {
        const rawImageIds = body.imageIds;
        if (Array.isArray(rawImageIds)) {
          return [...new Set(rawImageIds.map((v: any) => Number(v)).filter((v: any) => Number.isInteger(v) && v > 0))];
        }
        if (typeof rawImageIds === 'string') {
          try {
            const parsed = JSON.parse(rawImageIds);
            if (Array.isArray(parsed)) {
              return [...new Set(parsed.map((v: any) => Number(v)).filter((v: any) => Number.isInteger(v) && v > 0))];
            }
          } catch (_) {}
        }
        return [] as number[];
      })();
      const dynamicEntries = Object.entries(rawDynamicValues as Record<string, any>);
      const dynamicValuesByLowerKey = new Map<string, any>(
        dynamicEntries.map(([key, value]) => [String(key).trim().toLowerCase(), value])
      );

      if (!title) return ctx.badRequest('title is required.');
      if (!description) return ctx.badRequest('description is required.');
      if (!Number.isFinite(priceNumber) || priceNumber <= 0) return ctx.badRequest('price must be > 0.');
      if (!Number.isInteger(categoryId) || categoryId <= 0) return ctx.badRequest('categoryId is required.');

      const conditionRawValue = dynamicValuesByLowerKey.get('condition') ?? body.condition;
      const condition = normalizeCondition(conditionRawValue);
      if (!condition) {
        return ctx.badRequest('condition is required and must match product enum values.');
      }

      const rawBrandValue = dynamicValuesByLowerKey.get('brand') ?? body.brand;
      const rawSizeValue = dynamicValuesByLowerKey.get('size') ?? body.size;

      const categoryPromise = strapi.entityService.findMany('api::category.category', {
        filters: { id: { $eq: categoryId } },
        fields: ['id'],
        limit: 1,
      });

      let brandId: number | null = null;
      const brandPromise = (async () => {
        if (rawBrandValue == null || String(rawBrandValue).trim() === '') return null;
        const asBrandId = Number(rawBrandValue);
        const brandFilters = Number.isInteger(asBrandId) && asBrandId > 0
          ? { id: { $eq: asBrandId } }
          : { slug: { $eq: String(rawBrandValue).trim().toLowerCase() } };

        const brandRows = await strapi.entityService.findMany('api::brand.brand', {
          filters: brandFilters,
          fields: ['id'],
          limit: 1,
        });
        return brandRows?.[0]?.id ? Number(brandRows[0].id) : null;
      })();

      let sizeId: number | null = null;
      const sizePromise = (async () => {
        if (rawSizeValue == null || String(rawSizeValue).trim() === '') return null;
        const asSizeId = Number(rawSizeValue);
        if (!Number.isInteger(asSizeId) || asSizeId <= 0) return null;
        const sizeRows = await strapi.entityService.findMany('api::size.size', {
          filters: { id: { $eq: asSizeId } },
          fields: ['id'],
          limit: 1,
        });
        return sizeRows?.[0]?.id ? Number(sizeRows[0].id) : null;
      })();

      const [categoryRows, resolvedBrandId, resolvedSizeId] = await Promise.all([
        categoryPromise,
        brandPromise,
        sizePromise,
      ]);

      if (!categoryRows?.[0]) return ctx.badRequest('Invalid categoryId.');
      brandId = resolvedBrandId;
      sizeId = resolvedSizeId;

      const createdProduct = await strapi.db.query('api::product.product').create({
        data: {
          title,
          description: toBlocks(description),
          condition,
          productStatus: 'active',
          price: String(priceNumber),
          category: categoryId,
          ...(brandId ? { brand: brandId } : {}),
          ...(sizeId ? { size: sizeId } : {}),
        },
      });

      if (imageIds.length > 0) {
        await strapi.db.query('api::product.product').update({
          where: { id: createdProduct.id },
          data: { images: imageIds },
        });
      }

      const attributeEntries = dynamicEntries
        .filter(([code]) => !['brand', 'size', 'condition'].includes(String(code).trim().toLowerCase()))
        .map(([code, rawValue]) => ({ code: String(code), rawValue }))
        .filter(({ rawValue }) => rawValue != null && String(rawValue).trim() !== '');

      if (attributeEntries.length > 0) {
        const uniqueCodes = [...new Set(attributeEntries.map((entry) => entry.code))];
        const categoryAttributes = await strapi.entityService.findMany('api::category-attribute.category-attribute', {
          filters: { code: { $in: uniqueCodes } },
          fields: ['id', 'code', 'type'],
          limit: 1000,
        });

        const attributeByCode = new Map<string, any>();
        for (const attr of categoryAttributes as any[]) {
          const code = String(attr.code || '').trim();
          if (!code) continue;
          if (!attributeByCode.has(code)) attributeByCode.set(code, attr);
        }

        const enumAttributeIds = [...new Set(
          attributeEntries
            .map(({ code }) => attributeByCode.get(code))
            .filter((attr) => attr && String(attr.type) === 'enum')
            .map((attr) => Number(attr.id))
            .filter((id) => Number.isInteger(id) && id > 0)
        )];

        const optionIdByAttrAndValue = new Map<string, number>();
        if (enumAttributeIds.length > 0) {
          const enumOptions = await strapi.entityService.findMany('api::category-attribute-option.category-attribute-option', {
            filters: {
              category_attribute: { id: { $in: enumAttributeIds } },
            },
            fields: ['id', 'value'],
            populate: {
              category_attribute: {
                fields: ['id'],
              },
            },
            limit: 5000,
          });

          for (const option of enumOptions as any[]) {
            const attrId = Number(option?.category_attribute?.id);
            const value = String(option?.value ?? '').trim().toLowerCase();
            const optionId = Number(option?.id);
            if (!Number.isInteger(attrId) || !value || !Number.isInteger(optionId)) continue;
            optionIdByAttrAndValue.set(`${attrId}::${value}`, optionId);
          }
        }

        const pavCreatePromises: Promise<any>[] = [];
        for (const { code, rawValue } of attributeEntries) {
          const categoryAttribute = attributeByCode.get(code);
          if (!categoryAttribute) continue;

          const valueType = String(categoryAttribute.type || 'string');
          let valueText: string | null = null;
          let valueNumber: string | null = null;
          let valueBoolean: boolean | null = null;
          let optionId: number | null = null;

          if (valueType === 'number') {
            const asNumber = Number(rawValue);
            if (!Number.isFinite(asNumber)) continue;
            valueNumber = String(asNumber);
          } else if (valueType === 'boolean') {
            valueBoolean = String(rawValue).toLowerCase() === 'true' || rawValue === true || rawValue === 1 || rawValue === '1';
          } else if (valueType === 'enum') {
            const rawText = String(rawValue).trim();
            valueText = rawText;
            optionId = optionIdByAttrAndValue.get(`${Number(categoryAttribute.id)}::${rawText.toLowerCase()}`) ?? null;
          } else {
            valueText = String(rawValue).trim();
          }

          pavCreatePromises.push(
            strapi.db.query('api::product-attribute-value.product-attribute-value').create({
              data: {
                product: createdProduct.id,
                category_attribute: categoryAttribute.id,
                ...(valueText != null ? { valueText } : {}),
                ...(valueNumber != null ? { valueNumber } : {}),
                ...(valueBoolean != null ? { valueBoolean } : {}),
                ...(optionId ? { category_attribute_option: optionId } : {}),
              },
            })
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
      return ctx.internalServerError('Failed to create product.');
    }
  },
  async getProducts(ctx: any) {
    try {
      const query = ctx.query || {};
      const products = await strapi.entityService.findMany('api::product.product', {
        fields: ['id', 'title', 'price', 'condition', 'createdAt'],
        populate: [
          "category",
          "brand",
          "size",
          "images"
        ],
        sort: { createdAt: 'desc' },
        limit: 20,
        offset: query?.offset ? Number(query?.offset) : 0,
      }) as any[];

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
            ? product.images.map((img:any) => ({ id: img.id, url: img.url }))
            : [],

        }))
      };
    } catch (error) {
      strapi.log.error(error);
      return ctx.internalServerError('Failed to fetch products.');
    }
  },
  async getProductById(ctx: any) {
    try {
      const id = Number(ctx.params?.id);
      if (!Number.isInteger(id) || id <= 0) {
        return ctx.badRequest('A valid product id is required.');
      }

      const productData = await strapi.entityService.findMany('api::product.product', {
        filters: { id: { $eq: id } },
        fields: ['id', 'title', 'price', 'condition', 'likeCount', 'createdAt', 'description'],
        populate: {
          category: { fields: ['name'] },
          brand: { fields: ['name'] },
          size: { fields: ['name'] },
          images: { fields: ['id', 'url'] },
          users_permissions_user: {
            fields: ['id', 'username','rating_avg','city','country']
          },
        },
        limit: 1,
      }) as any[];

      const product = productData?.[0] as any;
      if (!product) {
        return ctx.notFound('Product not found.');
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
            user: product?.users_permissions_user
        },
      };
    } catch (error) {
      strapi.log.error(error);
      return ctx.internalServerError('Failed to fetch product details.');
    }
  },
}));
