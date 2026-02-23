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

export default factories.createCoreController('api::product.product', ({ strapi }) => ({
  async createSellNow(ctx: any) {
    try {
      const body = ctx.request.body || {};
      const title = String(body.title || '').trim();
      const description = String(body.description || '').trim();
      const priceNumber = Number(body.price);
      const categoryId = Number(body.categoryId);
      const rawDynamicValues = body.dynamicValues && typeof body.dynamicValues === 'object'
        ? body.dynamicValues
        : {};

      if (!title) return ctx.badRequest('title is required.');
      if (!description) return ctx.badRequest('description is required.');
      if (!Number.isFinite(priceNumber) || priceNumber <= 0) return ctx.badRequest('price must be > 0.');
      if (!Number.isInteger(categoryId) || categoryId <= 0) return ctx.badRequest('categoryId is required.');

      const categoryRows = await strapi.entityService.findMany('api::category.category', {
        filters: { id: { $eq: categoryId } },
        fields: ['id'],
        limit: 1,
      });
      if (!categoryRows?.[0]) return ctx.badRequest('Invalid categoryId.');

      const condition = normalizeCondition(rawDynamicValues.condition);
      if (!condition) {
        return ctx.badRequest('condition is required and must match product enum values.');
      }

      let brandId: number | null = null;
      const rawBrandValue = rawDynamicValues.brand;
      if (rawBrandValue != null && String(rawBrandValue).trim() !== '') {
        const asBrandId = Number(rawBrandValue);
        const brandFilters = Number.isInteger(asBrandId) && asBrandId > 0
          ? { id: { $eq: asBrandId } }
          : { slug: { $eq: String(rawBrandValue).trim().toLowerCase() } };

        const brandRows = await strapi.entityService.findMany('api::brand.brand', {
          filters: brandFilters,
          fields: ['id'],
          limit: 1,
        });
        brandId = brandRows?.[0]?.id ? Number(brandRows[0].id) : null;
      }

      let sizeId: number | null = null;
      const rawSizeValue = rawDynamicValues.size;
      if (rawSizeValue != null && String(rawSizeValue).trim() !== '') {
        const asSizeId = Number(rawSizeValue);
        if (Number.isInteger(asSizeId) && asSizeId > 0) {
          const sizeRows = await strapi.entityService.findMany('api::size.size', {
            filters: { id: { $eq: asSizeId } },
            fields: ['id'],
            limit: 1,
          });
          sizeId = sizeRows?.[0]?.id ? Number(sizeRows[0].id) : null;
        }
      }

      const createdProduct = await strapi.entityService.create('api::product.product', {
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

      const allCodes = Object.keys(rawDynamicValues);
      const attributeCodes = allCodes.filter((code) => !['brand', 'size', 'condition'].includes(code));

      for (const code of attributeCodes) {
        const rawValue = rawDynamicValues[code];
        if (rawValue == null || String(rawValue).trim() === '') continue;

        const categoryAttributes = await strapi.entityService.findMany('api::category-attribute.category-attribute', {
          filters: { code: { $eq: code } },
          fields: ['id', 'type'],
          limit: 1,
        });
        const categoryAttribute = categoryAttributes?.[0];
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
          const optionRows = await strapi.entityService.findMany('api::category-attribute-option.category-attribute-option', {
            filters: {
              category_attribute: { id: { $eq: categoryAttribute.id } },
              value: { $eq: rawText },
            },
            fields: ['id'],
            limit: 1,
          });
          optionId = optionRows?.[0]?.id ? Number(optionRows[0].id) : null;
        } else {
          valueText = String(rawValue).trim();
        }

        await strapi.entityService.create('api::product-attribute-value.product-attribute-value', {
          data: {
            product: createdProduct.id,
            category_attribute: categoryAttribute.id,
            ...(valueText != null ? { valueText } : {}),
            ...(valueNumber != null ? { valueNumber } : {}),
            ...(valueBoolean != null ? { valueBoolean } : {}),
            ...(optionId ? { category_attribute_option: optionId } : {}),
          },
        });
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
}));
