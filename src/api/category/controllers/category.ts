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
