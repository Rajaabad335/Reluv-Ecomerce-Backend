export default {
  routes: [
    {
      method: 'GET',
      path: '/categories/catalog-tree',
      handler: 'category.getCatalogTree',
      config: {},
    },
    {
      method: 'POST',
      path: '/categories/bulk-delete',
      handler: 'category.bulkDelete',
      config: {},
    },
    {
      method: 'GET',
      path: '/categories/upload-attributes',
      handler: 'category.getUploadAttributes',
      config: {},
    },
    {
      method: 'GET',
      path: '/item-upload/attributes',
      handler: 'category.getUploadAttributes',
      config: {},
    },
  ],
};
