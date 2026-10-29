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

const CONVERSATION_FIELDS = ["id", "lastMessageAt", "buyerDeletedAt", "sellerDeletedAt"];

/** In-process lock so simultaneous requests for the same pair don't duplicate. */
const pendingLookups = new Map<string, Promise<any>>();

function pairKey(buyerId: number, sellerId: number) {
  // Roles are part of the relationship: A buying from B is distinct from A
  // selling to B, even though both conversations involve the same two users.
  return `${buyerId}:${sellerId}`;
}

/** Resolve a retained legacy ID to its canonical conversation. */
export async function resolveCanonicalConversation(strapi: any, conversationId: number) {
  let current = await strapi.entityService.findOne(conversationUid, conversationId, {
    populate: { mergedInto: { fields: ["id"] } },
  });
  const seen = new Set<number>();
  while (current?.mergedInto?.id && !seen.has(Number(current.id))) {
    seen.add(Number(current.id));
    current = await strapi.entityService.findOne(conversationUid, Number(current.mergedInto.id), {
      populate: { mergedInto: { fields: ["id"] } },
    });
  }
  return current ?? null;
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

/**
 * Safe rerunnable migration: merge legacy duplicate conversations for the same
 * buyer-seller pair. Messages and offers are moved (not copied) onto the
 * earliest conversation; legacy rows remain as ID aliases. Offer product
 * relations are untouched, so every offer stays tied to its own product.
 */
export async function mergeDuplicateConversations(strapi: any): Promise<{
  mergedPairs: number;
  movedMessages: number;
  movedOffers: number;
  deletedConversations: number;
}> {
  const result = {
    mergedPairs: 0,
    movedMessages: 0,
    movedOffers: 0,
    deletedConversations: 0,
  };

  const all = (await strapi.entityService.findMany(conversationUid, {
    filters: { mergedInto: { id: { $null: true } } },
    populate: {
      buyer: { fields: ["id"] },
      seller: { fields: ["id"] },
    },
    fields: CONVERSATION_FIELDS,
    sort: { createdAt: "asc" },
    limit: -1,
  })) as any[];

  const groups = new Map<string, any[]>();
  for (const conv of all) {
    const buyerId = Number(conv?.buyer?.id);
    const sellerId = Number(conv?.seller?.id);
    if (!Number.isInteger(buyerId) || !Number.isInteger(sellerId)) continue;
    const key = pairKey(buyerId, sellerId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(conv);
  }

  for (const [, duplicates] of groups) {
    if (duplicates.length === 1) {
      const only = duplicates[0];
      await strapi.db.query(conversationUid).update({
        where: { id: only.id },
        data: { pairKey: pairKey(Number(only.buyer?.id), Number(only.seller?.id)) },
      });
      continue;
    }
    result.mergedPairs++;

    // Keep the oldest conversation so legacy links still resolve.
    const keep = duplicates[0];
    const keepId = Number(keep.id);

    // Merge per-side deletedAt: a user's delete must not resurrect history
    // merged from another conversation.
    const buyerDeletedAt = [keep.buyerDeletedAt, ...duplicates.slice(1).map((d: any) => d.buyerDeletedAt)]
      .filter(Boolean)
      .sort()[0] ?? null;
    const sellerDeletedAt = [keep.sellerDeletedAt, ...duplicates.slice(1).map((d: any) => d.sellerDeletedAt)]
      .filter(Boolean)
      .sort()[0] ?? null;

    let latestMessageAt: string | null = keep.lastMessageAt ?? null;
    let latestPreview: string | null = keep.lastMessagePreview ?? null;

    for (const dup of duplicates.slice(1)) {
      const dupId = Number(dup.id);

      if (dup.lastMessageAt && (!latestMessageAt || new Date(dup.lastMessageAt) > new Date(latestMessageAt))) {
        latestMessageAt = dup.lastMessageAt;
        latestPreview = dup.lastMessagePreview ?? latestPreview;
      }

      const dupMessages = (await strapi.entityService.findMany(messageUid, {
        filters: { conversation: { id: { $eq: dupId } } },
        fields: ["id", "createdAt", "metadata"],
        limit: -1,
      })) as any[];

      for (const msg of dupMessages) {
        const referencedProductId = Number(msg?.metadata?.productRef?.id);
        if (
          msg?.metadata?.type === "product_ref" &&
          Number.isInteger(referencedProductId) &&
          await hasProductRefMessage(strapi, keepId, referencedProductId)
        ) {
          // Keep the legacy duplicate row intact, while showing one canonical
          // card for this product in the merged chat.
          continue;
        }
        // Move (not copy): the message's own conversation relation is rewritten,
        // preserving content, attachments, offers and createdAt ordering.
        await strapi.db.query(messageUid).update({
          where: { id: msg.id },
          data: { conversation: keepId },
        });
        result.movedMessages++;
        if (
          msg.createdAt &&
          (!latestMessageAt || new Date(msg.createdAt) > new Date(latestMessageAt))
        ) {
          latestMessageAt = msg.createdAt;
          latestPreview = "Message";
        }
      }

      const dupOffers = (await strapi.entityService.findMany("api::offer.offer" as any, {
        filters: { conversation: { id: { $eq: dupId } } },
        fields: ["id"],
        limit: -1,
      })) as any[];
      for (const offer of dupOffers) {
        await strapi.db.query("api::offer.offer" as any).update({
          where: { id: offer.id },
          data: { conversation: keepId },
        });
        result.movedOffers++;
      }

      // Retain the legacy row so old links and references keep a stable ID.
      // The canonical row alone owns the unique pairKey.
      await strapi.db.query(conversationUid).update({
        where: { id: dupId },
        data: { mergedInto: keepId, pairKey: null },
      });
    }

    await strapi.db.query(conversationUid).update({
      where: { id: keepId },
      data: {
        pairKey: pairKey(Number(keep.buyer?.id), Number(keep.seller?.id)),
        lastMessageAt: latestMessageAt ?? keep.lastMessageAt ?? null,
        ...(latestPreview ? { lastMessagePreview: latestPreview } : {}),
        ...(buyerDeletedAt ? { buyerDeletedAt } : {}),
        ...(sellerDeletedAt ? { sellerDeletedAt } : {}),
      },
    });
  }

  return result;
}
