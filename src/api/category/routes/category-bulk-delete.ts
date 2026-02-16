export default {
  routes: [
    {
      method: 'POST',
      path: '/categories/bulk-delete',
      handler: 'category.bulkDelete',
      config: {},
    },
  ],
};