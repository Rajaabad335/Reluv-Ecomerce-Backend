/**
 * Unified buyer-seller conversation logic.
 *
 * One buyer + one seller = ONE conversation, regardless of how many products
 * they discuss. Products are referenced inside the conversation through
 * `product_ref` messages (message.metadata.productRef) and through offers,
 * which always keep their own independent `product` relation.
 *
 * The `conversation.product` relation is kept as the *initial/primary* product
 * for backward compatibility with existing clients that display
 * `conversation.product` in the list/header.
 */

const conversationUid = "api::conversation.conversation" as any;
const messageUid = "api::message.message" as any;
const productUid = "api::product.product" as any;

export const CONVERSATION_POPULATE = {
  product: {
    fields: ["id", "title", "price", "productStatus", "documentId"],
    populate: { images: { fields: ["url"] } },
  },
  buyer: {
    fields: ["id", "username"],
    populate: { avatar: { fields: ["url"] } },
  },
  seller: {
    fields: ["id", "username"],
    populate: { avatar: { fields: ["url"] } },
  },
};

/** In-process lock so simultaneous requests for the same pair don't duplicate. */
const pendingLookups = new Map<string, Promise<any>>();

function pairKey(buyerId: number, sellerId: number) {
  // Roles are part of the relationship: A buying from B is distinct from A
  // selling to B, even though both conversations involve the same two users.
  return `${buyerId}:${sellerId}`;
}

export function buildProductRefSnapshot(product: any) {
  const images = product?.images ?? [];
  const image = images[0]?.url ?? images[0]?.formats?.thumbnail?.url ?? null;
  return {
    id: Number(product.id),
    documentId: product.documentId ?? null,
    title: product.title ?? null,
    price: product.price ?? null,
    image,
    productStatus: product.productStatus ?? null,
  };
}

async function loadProduct(strapi: any, productId: number) {
  const rows = (await strapi.entityService.findMany(productUid, {
    filters: { id: { $eq: productId } },
    fields: ["id", "documentId", "title", "price", "productStatus"],
    populate: { images: { fields: ["url"] } },
    limit: 1,
  })) as any[];
  return rows?.[0] ?? null;
}

/** Loads a product including its seller relation (used by socket bootstrap). */
export async function loadProductById(strapi: any, productId: number) {
  const rows = (await strapi.entityService.findMany(productUid, {
    filters: { id: { $eq: productId } },
    fields: ["id", "documentId", "title", "price", "productStatus"],
    populate: {
      images: { fields: ["url"] },
      users_permissions_user: { fields: ["id"] },
    },
    limit: 1,
  })) as any[];
  return rows?.[0] ?? null;
}

/** True when the conversation already contains a product_ref for productId. */
async function hasProductRefMessage(
  strapi: any,
  conversationId: number,
  productId: number,
): Promise<boolean> {
  // Avoid filtering JSON metadata in SQL: Strapi translates $contains to LIKE
  // on some database clients, which fails for PostgreSQL's jsonb column.
  const all = (await strapi.entityService.findMany(messageUid, {
    filters: { conversation: { id: { $eq: conversationId } } },
    fields: ["id", "metadata"],
    limit: -1,
  })) as any[];
  return all.some(
    (m: any) => Number(m?.metadata?.productRef?.id) === Number(productId),
  );
}

/**
 * Create the product_ref message ("Buyer is interested in Product X").
 * Idempotent: never inserts a duplicate reference for the same product.
 */
export async function ensureProductRefMessage(
  strapi: any,
  conversation: any,
  product: any,
  senderId: number,
): Promise<void> {
  if (!conversation?.id || !product?.id || !senderId) return;
  const conversationId = Number(conversation.id);
  const productId = Number(product.id);

  if (await hasProductRefMessage(strapi, conversationId, productId)) return;

  const ref = buildProductRefSnapshot(product);
  const now = new Date().toISOString();
  await strapi.entityService.create(messageUid, {
    data: {
      conversation: conversationId,
      sender: senderId,
      content: `Product shared: ${ref.title ?? "this product"}`,
      metadata: { type: "product_ref", productRef: ref },
    },
  });
  await strapi.entityService.update(conversationUid, conversationId, {
    data: {
      lastMessageAt: now,
      lastMessagePreview: "Product shared",
    },
  });
}

/**
 * Find the single conversation for a buyer-seller pair, creating it if needed.
 * Product references are expressed through product_ref messages + offers, so
 * the pair — not the product — is the lookup key.
 */
export async function findOrCreateConversationForPair(
  strapi: any,
  buyerId: number,
  sellerId: number,
  productId?: number | null,
  referenceSenderId: number = buyerId,
): Promise<any> {
  const key = pairKey(buyerId, sellerId);

  const run = async (): Promise<any> => {
    const existing = (await strapi.entityService.findMany(conversationUid, {
      filters: {
        buyer: { id: { $eq: buyerId } },
        seller: { id: { $eq: sellerId } },
        pairKey: { $eq: pairKey(buyerId, sellerId) },
      },
      populate: CONVERSATION_POPULATE,
      sort: { lastMessageAt: "desc" },
      limit: 1,
    })) as any[];

    let conversation = existing?.[0] ?? null;

    if (!conversation) {
      // Product is set as the conversation's primary product (legacy display),
      // but the identity of the conversation is the buyer-seller pair.
      try {
        conversation = (await strapi.entityService.create(conversationUid, {
          data: {
            ...(productId ? { product: Number(productId) } : {}),
            buyer: buyerId,
            seller: sellerId,
            pairKey: pairKey(buyerId, sellerId),
            lastMessageAt: new Date().toISOString(),
            lastMessagePreview: "",
          },
          populate: CONVERSATION_POPULATE,
        })) as any;
      } catch (error) {
        // The unique pairKey is the cross-process guard; concurrent requests
        // that race to create the same relationship reuse the winning row.
        const winner = (await strapi.entityService.findMany(conversationUid, {
          filters: { pairKey: { $eq: pairKey(buyerId, sellerId) } },
          populate: CONVERSATION_POPULATE,
          limit: 1,
        })) as any[];
        if (!winner?.[0]) throw error;
        conversation = winner[0];
      }
    }

    // Every product opened from chat gets an in-thread card, including the
    // initial product that remains on conversation.product for compatibility.
    if (productId) {
      const product = await loadProduct(strapi, Number(productId));
      if (product) {
        await ensureProductRefMessage(strapi, conversation, product, referenceSenderId);
        conversation = await strapi.entityService.findOne(conversationUid, Number(conversation.id), {
          populate: CONVERSATION_POPULATE,
        });
      }
    }

    return conversation;
  };

  const inflight = pendingLookups.get(key);
  if (inflight) return inflight;

  const promise = run().finally(() => pendingLookups.delete(key));
  pendingLookups.set(key, promise);
  return promise;
}

export function sanitizeConversationPayload(conversation: any, hasUnread = false) {
  return {
    id: conversation?.id,
    product: conversation?.product
      ? {
          id: conversation.product.id,
          documentId: conversation.product.documentId ?? null,
          title: conversation.product.title,
          price: conversation.product.price,
          productStatus: conversation.product.productStatus ?? null,
          images: conversation.product.images ?? [],
        }
      : null,
    buyer: conversation?.buyer
      ? {
          id: conversation.buyer.id,
          username: conversation.buyer.username,
          avatar: conversation.buyer.avatar ?? null,
        }
      : null,
    seller: conversation?.seller
      ? {
          id: conversation.seller.id,
          username: conversation.seller.username,
          avatar: conversation.seller.avatar ?? null,
        }
      : null,
    lastMessagePreview: conversation?.lastMessagePreview ?? null,
    lastMessageAt: conversation?.lastMessageAt ?? null,
    updatedAt: conversation?.updatedAt ?? null,
    hasUnread,
  };
}
