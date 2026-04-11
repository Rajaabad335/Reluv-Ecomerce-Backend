export default {
      async findManyWithBatches(data) {
    const batchSize = 10000;
    let resultData: any[] = [];
    let ids = data.ids;
    if (ids.length > 0) {
      for (let i = 0; i < ids.length; i += batchSize) {
        const batch = ids.slice(i, i + batchSize);

        const batchResult = await strapi.entityService.findMany(data.uid, {
          filters: {
            id: {
              $in: batch,
            },
          },
          populate: data.populateString ? data.populateString : ["*"],
        });

        resultData.push(...(Array.isArray(batchResult) ? batchResult : [batchResult]));
      }
    }
    return resultData;
  },
}