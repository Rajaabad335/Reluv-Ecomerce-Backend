type NotificationType =
  | "welcome"
  | "login"
  | "product_created"
  | "new_message"
  | "new_follower"
  | "order_update"
  | "review";

interface CreateNotificationParams {
  strapi: any;
  recipientId: number;
  type: NotificationType;
  title: string;
  body?: string;
  link?: string;
}

export async function createNotification({
  strapi,
  recipientId,
  type,
  title,
  body,
  link,
}: CreateNotificationParams) {
  try {
    await strapi.entityService.create("api::notification.notification", {
      data: {
        recipient: recipientId,
        type,
        title,
        body: body ?? "",
        link: link ?? "",
        read: false,
      },
    });
  } catch (err) {
    strapi.log.error("[createNotification] failed:", err);
  }
}
