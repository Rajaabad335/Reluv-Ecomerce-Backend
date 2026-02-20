/**
 * category controller
 */

import { factories } from '@strapi/strapi';

let schemaConfigPromise = null;

const isTruthy = (value) =>
  value === true || value === 1 || value === '1' || value === 't' || value === 'true';

const categorySorter = (a, b) => {
  const aSort = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
  const bSort = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
  if (aSort !== bSort) return aSort - bSort;

  const nameCompare = a.name.localeCompare(b.name);
  if (nameCompare !== 0) return nameCompare;

  return a.id - b.id;
};

const sortTree = (nodes) => {
  nodes.sort(categorySorter);
  for (const node of nodes) {
    sortTree(node.categories);
  }
  return nodes;
};

const slugifyCode = (value = '') =>
  String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

const defaultPlaceholderFor = (attribute) => {
  if (attribute.type === 'enum') return `Select ${attribute.name.toLowerCase()}`;
  if (attribute.type === 'boolean') return `Select ${attribute.name.toLowerCase()}`;
  return `Enter ${attribute.name.toLowerCase()}`;
};

const mapAttributeToUploadShape = (attribute, categorySlug) => {
  const code = attribute.code || `${slugifyCode(categorySlug)}_${slugifyCode(attribute.name)}`;
  const options = (attribute.category_attribute_options || []).map((option) => ({
    id: option.id,
    title: option.value,
  }));
  const displayType = attribute.displayType || (attribute.type === 'enum' ? 'list' : attribute.type);
  const placeholder = attribute.placeholder || defaultPlaceholderFor(attribute);

  return {
    code,
    has_children: false,
    value_ids: null,
    value: null,
    configuration: {
      title: attribute.isRequired ? attribute.name : `${attribute.name} (recommended)`,
      description: attribute.description || null,
      placeholder,
      field_placeholder: placeholder,
      banner: null,
      display_type: displayType,
      required: Boolean(attribute.isRequired),
      selection_type: attribute.selectionType || 'single',
      selection_limit: attribute.selectionLimit || 1,
      options: attribute.type === 'enum'
        ? [
            {
              id: attribute.id,
              title: attribute.name,
              group_title: null,
              type: 'group',
              options,
            },
          ]
        : [],
    },
  };
};

const getSchemaConfig = async (strapi) => {
  if (schemaConfigPromise) {
    return schemaConfigPromise;
  }

  schemaConfigPromise = (async () => {
    const columnRows = await strapi.db.connection('information_schema.columns')
      .select('column_name')
      .where({ table_name: 'categories' });

    const columns = new Set(columnRows.map((row) => row.column_name));

    const parentColumn = columns.has('category_id')
      ? 'category_id'
      : columns.has('categoryId')
        ? 'categoryId'
        : null;
    const documentIdColumn = columns.has('document_id')
      ? 'document_id'
      : columns.has('documentId')
        ? 'documentId'
        : null;
    const isActiveColumn = columns.has('is_active')
      ? 'is_active'
      : columns.has('isActive')
        ? 'isActive'
        : null;
    const sortOrderColumn = columns.has('sort_order')
      ? 'sort_order'
      : columns.has('sortOrder')
        ? 'sortOrder'
        : null;

    if (!documentIdColumn || !isActiveColumn || !sortOrderColumn) {
      throw new Error('Categories table columns do not match expected schema.');
    }

    if (parentColumn) {
      return {
        mode: 'direct',
        documentIdColumn,
        isActiveColumn,
        sortOrderColumn,
        parentColumn,
      };
    }

    const linkRows = await strapi.db.connection('information_schema.columns')
      .select('table_name', 'column_name')
      .where('table_name', 'like', 'categories%lnk');

    const byTable = new Map();
    for (const row of linkRows) {
      const cols = byTable.get(row.table_name) ?? [];
      cols.push(row.column_name);
      byTable.set(row.table_name, cols);
    }

    for (const [tableName, tableColumns] of byTable) {
      const categoryCols = tableColumns.filter((c) => c.toLowerCase().includes('category') && c.endsWith('_id'));
      if (categoryCols.length >= 2) {
        const invCol = categoryCols.find((c) => c.toLowerCase().includes('inv_'));
        const childColumn = invCol ? categoryCols.find((c) => c !== invCol) ?? null : categoryCols[0];
        const parentLinkColumn = invCol ?? categoryCols[1];

        if (childColumn && parentLinkColumn) {
          return {
            mode: 'link',
            documentIdColumn,
            isActiveColumn,
            sortOrderColumn,
            linkTable: tableName,
            childColumn,
            parentColumn: parentLinkColumn,
          };
        }
      }
    }

    throw new Error('Could not determine self relation link table for categories.');
  })();

  return schemaConfigPromise;
};

export default factories.createCoreController('api::category.category', ({ strapi }) => ({
  async getUploadAttributes(ctx) {
    try {
      const rawCategoryId = ctx.query.category_id;
      const categorySlug = String(ctx.query.category_slug || '').trim();
      const categoryId = rawCategoryId == null ? null : Number(rawCategoryId);

      if (!categorySlug && (!Number.isInteger(categoryId) || categoryId <= 0)) {
        return ctx.badRequest('Provide category_id or category_slug.');
      }

      const categoryFilters = categorySlug
        ? { slug: { $eq: categorySlug } }
        : { id: { $eq: categoryId } };

      const categories = await strapi.entityService.findMany('api::category.category', {
        filters: categoryFilters,
        fields: ['id', 'slug', 'name'],
        limit: 1,
      });

      const category = categories?.[0];
      if (!category) {
        return ctx.notFound('Category not found.');
      }

      const attributes = await strapi.entityService.findMany('api::category-attribute.category-attribute', {
        filters: { category: { id: { $eq: category.id } } },
        populate: {
          category_attribute_options: {
            fields: ['id', 'value', 'sortOrder'],
            sort: ['sortOrder:asc', 'value:asc'],
          },
        },
        sort: ['name:asc'],
      } as any);

      const requiredFieldCodes = [];
      const mappedAttributes = attributes.map((attribute) => {
        const mapped = mapAttributeToUploadShape(attribute, category.slug || category.name);
        if (attribute.isRequired) requiredFieldCodes.push(mapped.code);
        return mapped;
      });

      const brands = await strapi.entityService.findMany('api::brand.brand', {
        filters: { categories: { id: { $eq: category.id } } },
        fields: ['id', 'name', 'slug'],
        sort: ['name:asc'],
        limit: 500,
      } as any);

      const sizes = await strapi.entityService.findMany('api::size.size', {
        filters: { category: { id: { $eq: category.id } } },
        fields: ['id', 'label'],
        sort: ['label:asc'],
        limit: 500,
      });

      ctx.body = {
        code: 0,
        message: null,
        category: {
          id: category.id,
          slug: category.slug,
          name: category.name,
        },
        attributes: mappedAttributes,
        required_field_codes: requiredFieldCodes,
        brands: brands.map((brand) => ({
          id: brand.id,
          title: brand.name,
          slug: brand.slug,
        })),
        sizes: sizes.map((size) => ({
          id: size.id,
          title: size.label,
        })),
      };
    } catch (error) {
      strapi.log.error(error);
      return ctx.internalServerError('Failed to load upload attributes.');
    }
  },
  async bulkDelete(ctx) {
    const body = ctx.request.body;
    const rawIds = Array.isArray(body?.ids) ? body.ids : [];
    const ids = [...new Set(rawIds.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0))];

    if (ids.length === 0) {
      return ctx.badRequest('Body must include a non-empty ids array of positive integers.');
    }

    const deletedCount = await strapi
      .service('api::category.category')
      .bulkDeleteByIds(ids);

    ctx.body = {
      ok: true,
      deletedCount,
      requestedCount: ids.length,
    };
  },
  async getCatalogTree(ctx) {
    try {
      const schema = await getSchemaConfig(strapi);

      let categories;

      if (schema.mode === 'direct') {
        const rows = await strapi.db.connection('categories').select(
          'id',
          { documentId: schema.documentIdColumn },
          'name',
          'slug',
          { isActive: schema.isActiveColumn },
          { sortOrder: schema.sortOrderColumn },
          { parentId: schema.parentColumn }
        );

        categories = rows
          .map((row) => ({
            id: Number(row.id),
            documentId: String(row.documentId ?? ''),
            name: String(row.name ?? ''),
            slug: String(row.slug ?? ''),
            isActive: isTruthy(row.isActive),
            sortOrder: row.sortOrder == null ? null : Number(row.sortOrder),
            parentId: row.parentId == null ? null : Number(row.parentId),
          }))
          .filter((category) => category.isActive);
      } else {
        const [categoryRows, linkRows] = await Promise.all([
          strapi.db.connection('categories').select(
            'id',
            { documentId: schema.documentIdColumn },
            'name',
            'slug',
            { isActive: schema.isActiveColumn },
            { sortOrder: schema.sortOrderColumn }
          ),
          strapi.db.connection(schema.linkTable).select(
            { childId: schema.childColumn },
            { parentId: schema.parentColumn }
          ),
        ]);

        const parentByChild = new Map();
        for (const row of linkRows) {
          const childId = Number(row.childId);
          const parentId = Number(row.parentId);
          if (Number.isInteger(childId) && Number.isInteger(parentId)) {
            parentByChild.set(childId, parentId);
          }
        }

        categories = categoryRows
          .map((row) => {
            const id = Number(row.id);
            return {
              id,
              documentId: String(row.documentId ?? ''),
              name: String(row.name ?? ''),
              slug: String(row.slug ?? ''),
              isActive: isTruthy(row.isActive),
              sortOrder: row.sortOrder == null ? null : Number(row.sortOrder),
              parentId: parentByChild.get(id) ?? null,
            };
          })
          .filter((category) => category.isActive);
      }

      const nodeById = new Map();
      for (const category of categories) {
        nodeById.set(category.id, {
          id: category.id,
          documentId: category.documentId,
          name: category.name,
          slug: category.slug,
          isActive: category.isActive,
          sortOrder: category.sortOrder,
          categories: [],
        });
      }

      const roots = [];
      for (const category of categories) {
        const node = nodeById.get(category.id);
        if (!node) continue;

        if (category.parentId == null) {
          roots.push(node);
          continue;
        }

        const parentNode = nodeById.get(category.parentId);
        if (parentNode) {
          parentNode.categories.push(node);
        }
      }

      ctx.body = {
        data: sortTree(roots),
      };
    } catch (error) {
      schemaConfigPromise = null;
      strapi.log.error(error);
      return ctx.internalServerError('Failed to build category tree.');
    }
  },
}));
