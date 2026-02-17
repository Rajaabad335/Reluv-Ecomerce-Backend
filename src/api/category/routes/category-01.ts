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
  ],
};
