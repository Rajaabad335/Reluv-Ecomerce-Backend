export default {
  routes: [
    {
      method: 'GET',
      path: '/categories/catalog-tree',
      handler: 'category.getCatalogTree',
      config: {
        auth: false,
      },
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
      config: {
        auth: false,
      },
    },
    {
      method: 'GET',
      path: '/item-upload/attributes',
      handler: 'category.getUploadAttributes',
      config: {
        auth: false,
      },
    },
    {
      method: 'GET',
      path: '/item-upload/dropdown',
      handler: 'category.getUploadDropdown',
      config: {
        auth: false,
      },
    },
  ],
};
