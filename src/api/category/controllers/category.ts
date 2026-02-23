/**
 * category controller
 */

import { factories } from '@strapi/strapi';

let schemaConfigPromise = null;
let uploadAttributeSchemaPromise = null;

const qi = (strapi: any, name: string) => {
  const client = String(strapi?.db?.connection?.client?.config?.client || '').toLowerCase();
  const quote = client.includes('mysql') ? '`' : '"';
  const escaped = String(name).replace(new RegExp(quote, 'g'), `${quote}${quote}`);
  return `${quote}${escaped}${quote}`;
};

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
  
  // Get options from category_attribute_options relation
  const attributeOptions = attribute.category_attribute_options || [];
  const options = attributeOptions.map((option: any) => ({
    id: option.id,
    title: option.value,
    value: option.value,
  }));
  
  // Determine display type - use 'list' for enum types or if there are options
  const hasOptions = options.length > 0;
  const displayType = attribute.displayType || (hasOptions ? 'list' : (attribute.type === 'enum' ? 'list' : attribute.type));
  const placeholder = attribute.placeholder || defaultPlaceholderFor(attribute);

  // Determine field type
  const fieldType = hasOptions ? 'select' : (attribute.type === 'enum' ? 'select' : (attribute.type === 'boolean' ? 'boolean' : 'text'));

  return {
    code,
    has_children: false,
    value_ids: null,
    value: null,
    // Also include raw data for easier frontend processing
    rawType: attribute.type,
    rawOptions: options,
    configuration: {
      title: attribute.isRequired ? attribute.name : `${attribute.name} (recommended)`,
      description: attribute.description || null,
      placeholder,
      field_placeholder: placeholder,
      banner: null,
      display_type: displayType,
      field_type: fieldType,
      required: Boolean(attribute.isRequired),
      selection_type: attribute.selectionType || 'single',
      selection_limit: attribute.selectionLimit || 1,
      // Always include options array if there are options
      options: hasOptions
        ? [
            {
              id: attribute.id,
              title: attribute.name,
              group_title: null,
              type: 'group',
              options: options,
            },
          ]
        : [],
    },
  };
};

const getSchemaConfig = async (strapi: any) => {
  if (schemaConfigPromise) {
    return schemaConfigPromise;
  }

  schemaConfigPromise = (async () => {
    const columnRows = await strapi.db.connection('information_schema.columns')
      .select('column_name')
      .where({ table_name: 'categories' });

    const columns = new Set(columnRows.map((row: any) => row.column_name));

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
      const categoryCols = tableColumns.filter((c: string) => c.toLowerCase().includes('category') && c.endsWith('_id'));
      if (categoryCols.length >= 2) {
        const invCol = categoryCols.find((c: string) => c.toLowerCase().includes('inv_'));
        const childColumn = invCol ? categoryCols.find((c: string) => c !== invCol) ?? null : categoryCols[0];
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

const getUploadAttributeSchema = async (strapi: any) => {
  if (uploadAttributeSchemaPromise) {
    return uploadAttributeSchemaPromise;
  }

  uploadAttributeSchemaPromise = (async () => {
    const rows = await strapi.db.connection('information_schema.columns')
      .select('table_name', 'column_name')
      .whereIn('table_name', ['category_attributes', 'category_attribute_options']);

    const byTable = new Map<string, Set<string>>();
    for (const row of rows) {
      const table = String((row as any).table_name);
      const column = String((row as any).column_name);
      const current = byTable.get(table) ?? new Set<string>();
      current.add(column);
      byTable.set(table, current);
    }

    const findColumn = (columns: Set<string>, candidates: string[]) =>
      candidates.find((candidate) => columns.has(candidate)) ?? null;

    const attrColumns = byTable.get('category_attributes') ?? new Set<string>();
    const optionColumns = byTable.get('category_attribute_options') ?? new Set<string>();

    let schema: any = {
      attributesTable: 'category_attributes',
      optionsTable: 'category_attribute_options',
      relationMode: 'direct',
      attrCategoryId: findColumn(attrColumns, ['category_id', 'categoryId']),
      attrPublishedAt: findColumn(attrColumns, ['published_at', 'publishedAt']),
      attrIsRequired: findColumn(attrColumns, ['is_required', 'isRequired']),
      attrDisplayType: findColumn(attrColumns, ['display_type', 'displayType']),
      attrSelectionType: findColumn(attrColumns, ['selection_type', 'selectionType']),
      attrSelectionLimit: findColumn(attrColumns, ['selection_limit', 'selectionLimit']),
      optionAttributeId: findColumn(optionColumns, ['category_attribute_id', 'categoryAttributeId']),
      optionSortOrder: findColumn(optionColumns, ['sort_order', 'sortOrder']),
      optionPublishedAt: findColumn(optionColumns, ['published_at', 'publishedAt']),
    };

    if (!schema.attrCategoryId) {
      let linkRows: any[] = [];
      try {
        linkRows = await strapi.db.connection('information_schema.columns')
          .select('table_name', 'column_name')
          .where('table_name', 'like', 'category_attributes%lnk');
      } catch (error) {
        linkRows = [];
      }

      const linkByTable = new Map<string, string[]>();
      for (const row of linkRows as any[]) {
        const t = String(row.table_name);
        const c = String(row.column_name);
        const cols = linkByTable.get(t) ?? [];
        cols.push(c);
        linkByTable.set(t, cols);
      }

      for (const [tableName, cols] of linkByTable) {
        const isIdCol = (c: string) => c.endsWith('_id') || c.endsWith('Id');
        const attrCol = cols.find((c) => c.toLowerCase().includes('category_attribute') && isIdCol(c)) ?? null;
        const catCol = cols.find((c) => c.toLowerCase().includes('category') && !c.toLowerCase().includes('attribute') && isIdCol(c)) ?? null;
        if (attrCol && catCol) {
          schema = {
            ...schema,
            relationMode: 'link',
            attrCategoryId: null,
            attrLinkTable: tableName,
            attrLinkAttributeId: attrCol,
            attrLinkCategoryId: catCol,
          };
          break;
        }
      }
    }

    if (schema.relationMode === 'link' && (!schema.attrLinkTable || !schema.attrLinkAttributeId || !schema.attrLinkCategoryId)) {
      schema = {
        ...schema,
        relationMode: 'direct',
      };
    }

    if (!schema.attrCategoryId && schema.relationMode !== 'link') {
      const guessedCategoryId = findColumn(attrColumns, ['categoryId', 'category_id']);
      schema = {
        ...schema,
        relationMode: 'direct',
        attrCategoryId: guessedCategoryId || 'categoryId',
      };
    }

    if (schema.relationMode === 'direct' && !schema.attrCategoryId) {
      schema = {
        ...schema,
        disabled: true,
      };
    }

    return schema;
  })();

  try {
    return await uploadAttributeSchemaPromise;
  } catch (error) {
    uploadAttributeSchemaPromise = null;
    throw error;
  }
};

export default factories.createCoreController('api::category.category', ({ strapi }: { strapi: any }) => ({
  async getUploadAttributes(ctx: any) {
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

      const schema = await getSchemaConfig(strapi);
      const getAllParentIds = async (catId: number): Promise<number[]> => {
        const parentIds: number[] = [];
        const seen = new Set<number>();
        let currentId: number | null = catId;

        while (currentId && !seen.has(currentId)) {
          seen.add(currentId);
          let parentId: number | null = null;

          if (schema.mode === 'direct') {
            const rows = await strapi.db.connection('categories')
              .select({ parentId: schema.parentColumn })
              .where('id', currentId)
              .limit(1);
            if (rows.length > 0 && rows[0].parentId) {
              parentId = Number(rows[0].parentId);
            }
          } else {
            const linkRows = await strapi.db.connection(schema.linkTable)
              .select({ parentId: schema.parentColumn })
              .where(schema.childColumn, currentId)
              .limit(1);
            if (linkRows.length > 0 && linkRows[0].parentId) {
              parentId = Number(linkRows[0].parentId);
            }
          }

          if (!parentId || !Number.isInteger(parentId) || parentId <= 0) break;
          parentIds.push(parentId);
          currentId = parentId;
        }

        return parentIds;
      };

      const parentIds = await getAllParentIds(category.id);
      const allCategoryIds = [category.id, ...parentIds];
      const rawSchema = await getUploadAttributeSchema(strapi);
      if ((rawSchema as any).disabled) {
        ctx.body = {
          code: 0,
          message: null,
          category: {
            id: category.id,
            slug: category.slug,
            name: category.name,
          },
          attributes: [],
          required_field_codes: [],
          brands: [],
          sizes: [],
        };
        return;
      }
      const idPlaceholders = allCategoryIds.map(() => '?').join(', ');
      const caTable = qi(strapi, rawSchema.attributesTable);
      const caAlias = 'ca';
      const lcaAlias = 'lca';
      if (rawSchema.relationMode !== 'link' && !rawSchema.attrCategoryId) {
        ctx.body = {
          code: 0,
          message: null,
          category: {
            id: category.id,
            slug: category.slug,
            name: category.name,
          },
          attributes: [],
          required_field_codes: [],
          brands: [],
          sizes: [],
        };
        return;
      }
      const categoryIdExpr = rawSchema.relationMode === 'link'
        ? `${lcaAlias}.${qi(strapi, rawSchema.attrLinkCategoryId)}`
        : `${caAlias}.${qi(strapi, rawSchema.attrCategoryId)}`;
      const joinClause = rawSchema.relationMode === 'link'
        ? `JOIN ${qi(strapi, rawSchema.attrLinkTable)} ${lcaAlias} ON ${lcaAlias}.${qi(strapi, rawSchema.attrLinkAttributeId)} = ${caAlias}.${qi(strapi, 'id')}`
        : '';
      const isRequiredSelect = rawSchema.attrIsRequired
        ? `${caAlias}.${qi(strapi, rawSchema.attrIsRequired)} AS is_required_value`
        : `NULL AS is_required_value`;
      const displayTypeSelect = rawSchema.attrDisplayType
        ? `${caAlias}.${qi(strapi, rawSchema.attrDisplayType)} AS display_type_value`
        : `NULL AS display_type_value`;
      const selectionTypeSelect = rawSchema.attrSelectionType
        ? `${caAlias}.${qi(strapi, rawSchema.attrSelectionType)} AS selection_type_value`
        : `NULL AS selection_type_value`;
      const selectionLimitSelect = rawSchema.attrSelectionLimit
        ? `${caAlias}.${qi(strapi, rawSchema.attrSelectionLimit)} AS selection_limit_value`
        : `NULL AS selection_limit_value`;
      const rawQuery = `
        SELECT
          ${caAlias}.${qi(strapi, 'id')} AS id,
          ${caAlias}.${qi(strapi, 'name')} AS name,
          ${caAlias}.${qi(strapi, 'type')} AS type,
          ${caAlias}.${qi(strapi, 'code')} AS code,
          ${caAlias}.${qi(strapi, 'placeholder')} AS placeholder,
          ${caAlias}.${qi(strapi, 'description')} AS description,
          ${isRequiredSelect},
          ${displayTypeSelect},
          ${selectionTypeSelect},
          ${selectionLimitSelect},
          ${categoryIdExpr} AS category_id_value
        FROM ${caTable} ${caAlias}
        ${joinClause}
        WHERE ${categoryIdExpr} IN (${idPlaceholders})
        ${rawSchema.attrPublishedAt ? `AND ${caAlias}.${qi(strapi, rawSchema.attrPublishedAt)} IS NOT NULL` : ''}
        ORDER BY ${caAlias}.${qi(strapi, 'name')} ASC
      `;
      const result = await strapi.db.connection.raw(rawQuery, allCategoryIds);
      const attributeRows = Array.isArray(result?.rows)
        ? result.rows
        : Array.isArray(result?.[0])
          ? result[0]
          : [];

      const attributesByCategoryId = new Map<number, any[]>();
      for (const row of attributeRows as any[]) {
        const catId = Number(row.category_id_value ?? row.categoryId ?? row.categoryid);
        if (!Number.isInteger(catId) || catId <= 0) continue;
        const bucket = attributesByCategoryId.get(catId) ?? [];
        bucket.push({
          id: Number(row.id),
          name: String(row.name ?? ''),
          type: String(row.type ?? 'string'),
          isRequired: isTruthy(row.is_required_value ?? row.isRequired ?? row.isrequired),
          code: row.code == null ? null : String(row.code),
          placeholder: row.placeholder == null ? null : String(row.placeholder),
          description: row.description == null ? null : String(row.description),
          displayType: row.display_type_value == null ? null : String(row.display_type_value),
          selectionType: row.selection_type_value == null ? null : String(row.selection_type_value),
          selectionLimit: row.selection_limit_value == null ? null : Number(row.selection_limit_value),
          category_attribute_options: [],
        });
        attributesByCategoryId.set(catId, bucket);
      }

      const attributesMap = new Map<string, any>();
      for (const catId of allCategoryIds) {
        for (const attr of attributesByCategoryId.get(catId) ?? []) {
          const code = attr.code || `attr_${attr.id}`;
          if (!attributesMap.has(code)) attributesMap.set(code, attr);
        }
      }

      const requiredFieldCodes: any[] = [];
      const mappedAttributes = Array.from(attributesMap.values()).map((attribute: any) => {
        const mapped = mapAttributeToUploadShape(attribute, category.slug || category.name);
        if (attribute.isRequired) requiredFieldCodes.push(mapped.code);
        return mapped;
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
        brands: [],
        sizes: [],
      };
    } catch (error) {
      strapi.log.error(error);
      return ctx.internalServerError('Failed to load upload attributes.');
    }
  },
  async getUploadDropdown(ctx: any) {
    try {
      const code = String(ctx.query.code || '').trim().toLowerCase();
      const rawCategoryId = ctx.query.category_id;
      const categorySlug = String(ctx.query.category_slug || '').trim();
      const categoryId = rawCategoryId == null ? null : Number(rawCategoryId);

      if (!code) return ctx.badRequest('Provide code.');
      if (!categorySlug && (!Number.isInteger(categoryId) || categoryId <= 0)) {
        return ctx.badRequest('Provide category_id or category_slug.');
      }

      const categoryFilters = categorySlug
        ? { slug: { $eq: categorySlug } }
        : { id: { $eq: categoryId } };
      const categories = await strapi.entityService.findMany('api::category.category', {
        filters: categoryFilters,
        fields: ['id'],
        limit: 1,
      });
      const category = categories?.[0];
      if (!category) return ctx.notFound('Category not found.');

      const schema = await getSchemaConfig(strapi);
      const getAllParentIds = async (catId: number): Promise<number[]> => {
        const parentIds: number[] = [];
        const seen = new Set<number>();
        let currentId: number | null = catId;
        while (currentId && !seen.has(currentId)) {
          seen.add(currentId);
          let parentId: number | null = null;
          if (schema.mode === 'direct') {
            const rows = await strapi.db.connection('categories')
              .select({ parentId: schema.parentColumn })
              .where('id', currentId)
              .limit(1);
            if (rows.length > 0 && rows[0].parentId) parentId = Number(rows[0].parentId);
          } else {
            const linkRows = await strapi.db.connection(schema.linkTable)
              .select({ parentId: schema.parentColumn })
              .where(schema.childColumn, currentId)
              .limit(1);
            if (linkRows.length > 0 && linkRows[0].parentId) parentId = Number(linkRows[0].parentId);
          }
          if (!parentId || !Number.isInteger(parentId) || parentId <= 0) break;
          parentIds.push(parentId);
          currentId = parentId;
        }
        return parentIds;
      };

      const allCategoryIds = [category.id, ...(await getAllParentIds(category.id))];

      if (code === 'brand') {
        const brands = await strapi.entityService.findMany('api::brand.brand', {
          filters: { categories: { id: { $in: allCategoryIds } } },
          fields: ['id', 'name', 'slug'],
          sort: ['name:asc'],
          limit: 500,
        });
        ctx.body = {
          code: 0,
          message: null,
          data_code: code,
          options: brands.map((brand: any) => ({
            id: brand.id,
            title: brand.name,
            value: brand.name,
            slug: brand.slug,
          })),
        };
        return;
      }

      if (code === 'size') {
        const sizes = await strapi.entityService.findMany('api::size.size', {
          filters: { categories: { id: { $in: allCategoryIds } } },
          fields: ['id', 'name'],
          sort: ['name:asc'],
          limit: 500,
        });
        ctx.body = {
          code: 0,
          message: null,
          data_code: code,
          options: sizes.map((size: any) => ({
            id: size.id,
            title: size.name,
            value: size.name,
          })),
        };
        return;
      }

      const rawSchema = await getUploadAttributeSchema(strapi);
      if ((rawSchema as any).disabled) {
        ctx.body = { code: 0, message: null, data_code: code, options: [] };
        return;
      }
      if (!rawSchema.optionAttributeId) {
        ctx.body = { code: 0, message: null, data_code: code, options: [] };
        return;
      }
      const idPlaceholders = allCategoryIds.map(() => '?').join(', ');
      const orderCase = allCategoryIds.map((id, i) => `WHEN ${id} THEN ${i}`).join(' ');
      const caTable = qi(strapi, rawSchema.attributesTable);
      const caAlias = 'ca';
      const lcaAlias = 'lca';
      if (rawSchema.relationMode !== 'link' && !rawSchema.attrCategoryId) {
        ctx.body = { code: 0, message: null, data_code: code, options: [] };
        return;
      }
      const categoryIdExpr = rawSchema.relationMode === 'link'
        ? `${lcaAlias}.${qi(strapi, rawSchema.attrLinkCategoryId)}`
        : `${caAlias}.${qi(strapi, rawSchema.attrCategoryId)}`;
      const attrJoinClause = rawSchema.relationMode === 'link'
        ? `JOIN ${qi(strapi, rawSchema.attrLinkTable)} ${lcaAlias} ON ${lcaAlias}.${qi(strapi, rawSchema.attrLinkAttributeId)} = ${caAlias}.${qi(strapi, 'id')}`
        : '';

      const attrRawQuery = `
        SELECT
          ${caAlias}.${qi(strapi, 'id')} AS id,
          ${categoryIdExpr} AS category_id_value
        FROM ${caTable} ${caAlias}
        ${attrJoinClause}
        WHERE ${caAlias}.${qi(strapi, 'code')} = ?
          AND ${categoryIdExpr} IN (${idPlaceholders})
          ${rawSchema.attrPublishedAt ? `AND ${caAlias}.${qi(strapi, rawSchema.attrPublishedAt)} IS NOT NULL` : ''}
        ORDER BY CASE ${categoryIdExpr} ${orderCase} ELSE 9999 END, ${caAlias}.${qi(strapi, 'id')} ASC
        LIMIT 1
      `;
      const attrResult = await strapi.db.connection.raw(attrRawQuery, [code, ...allCategoryIds]);
      const attrRows = Array.isArray(attrResult?.rows)
        ? attrResult.rows
        : Array.isArray(attrResult?.[0])
          ? attrResult[0]
          : [];
      const attribute = attrRows?.[0];
      if (!attribute) {
        ctx.body = { code: 0, message: null, data_code: code, options: [] };
        return;
      }

      const optionsRawQuery = `
        SELECT
          cao.${qi(strapi, 'id')} AS id,
          cao.${qi(strapi, 'value')} AS value
        FROM ${qi(strapi, rawSchema.optionsTable)} cao
        WHERE cao.${qi(strapi, rawSchema.optionAttributeId)} = ?
          ${rawSchema.optionPublishedAt ? `AND cao.${qi(strapi, rawSchema.optionPublishedAt)} IS NOT NULL` : ''}
        ORDER BY ${rawSchema.optionSortOrder ? `cao.${qi(strapi, rawSchema.optionSortOrder)} ASC,` : ''} cao.${qi(strapi, 'value')} ASC
      `;
      const optionsResult = await strapi.db.connection.raw(optionsRawQuery, [Number(attribute.id)]);
      const optionRows = Array.isArray(optionsResult?.rows)
        ? optionsResult.rows
        : Array.isArray(optionsResult?.[0])
          ? optionsResult[0]
          : [];

      ctx.body = {
        code: 0,
        message: null,
        data_code: code,
        options: (optionRows as any[]).map((row) => ({
          id: Number(row.id),
          title: String(row.value ?? ''),
          value: String(row.value ?? ''),
        })),
      };
    } catch (error) {
      strapi.log.error(error);
      return ctx.internalServerError('Failed to load dropdown data.');
    }
  },
  async bulkDelete(ctx: any) {
    const body = ctx.request.body;
    const rawIds = Array.isArray(body?.ids) ? body.ids : [];
    const ids = [...new Set(rawIds.map((v: any) => Number(v)).filter((v: any) => Number.isInteger(v) && v > 0))];

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
  async getCatalogTree(ctx: any) {
    try {
      const schema = await getSchemaConfig(strapi);

      let categories: any;

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
          .map((row: any) => ({
            id: Number(row.id),
            documentId: String(row.documentId ?? ''),
            name: String(row.name ?? ''),
            slug: String(row.slug ?? ''),
            isActive: isTruthy(row.isActive),
            sortOrder: row.sortOrder == null ? null : Number(row.sortOrder),
            parentId: row.parentId == null ? null : Number(row.parentId),
          }))
          .filter((category: any) => category.isActive);
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
          .map((row: any) => {
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
          .filter((category: any) => category.isActive);
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

      const roots: any[] = [];
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
