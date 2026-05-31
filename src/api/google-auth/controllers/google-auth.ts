const userUid = "plugin::users-permissions.user" as any;
const roleUid = "plugin::users-permissions.role" as any;

const GOOGLE_TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const GOOGLE_PEOPLE_API_URL =
  "https://people.googleapis.com/v1/people/me?personFields=addresses,phoneNumbers";

type GoogleTokenInfo = {
  aud?: string;
  sub?: string;
  email?: string;
  email_verified?: string | boolean;
  name?: string;
  picture?: string;
};

type GooglePersonAddress = {
  formattedValue?: string;
  streetAddress?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
};

type GooglePersonPhoneNumber = {
  value?: string;
};

type GooglePeopleInfo = {
  addresses?: GooglePersonAddress[];
  phoneNumbers?: GooglePersonPhoneNumber[];
};

type GoogleUserInfo = GoogleTokenInfo &
  GooglePeopleInfo & {
    given_name?: string;
    family_name?: string;
    locale?: string;
    address?: {
      formatted?: string;
      street_address?: string;
      locality?: string;
      region?: string;
      postal_code?: string;
      country?: string;
    };
    gender?: string;
    birthdate?: string;
    phone_number?: string;
  };

const normalizeUsername = (value: string) => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized.length >= 3 ? normalized : `${normalized || "user"}123`;
};

const findAvailableUsername = async (strapi: any, base: string) => {
  const normalized = normalizeUsername(base);

  for (let index = 0; index < 100; index += 1) {
    const username = index === 0 ? normalized : `${normalized}${index + 1}`;
    const existing = await strapi.db.query(userUid).findOne({
      where: { username },
      select: ["id"],
    });

    if (!existing) return username;
  }

  return `${normalized}${Date.now()}`;
};

const sanitizeUser = async (strapi: any, user: any, ctx: any) => {
  const schema = strapi.getModel(userUid);
  return strapi.contentAPI.sanitize.output(user, schema, {
    auth: ctx.state.auth,
  });
};

const verifyGoogleAccessToken = async (
  accessToken: string,
): Promise<GoogleTokenInfo> => {
  const response = await fetch(
    `${GOOGLE_TOKENINFO_URL}?access_token=${encodeURIComponent(accessToken)}`,
  );

  if (!response.ok) {
    throw new Error("Google token is invalid or expired.");
  }

  return response.json() as Promise<GoogleTokenInfo>;
};

const fetchGoogleUserInfo = async (
  accessToken: string,
): Promise<GoogleUserInfo | null> => {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) return null;

  return response.json() as Promise<GoogleUserInfo>;
};

const fetchGooglePeopleInfo = async (
  accessToken: string,
  logger?: { warn: (message: string, data?: any) => void },
): Promise<GooglePeopleInfo | null> => {
  try {
    const response = await fetch(GOOGLE_PEOPLE_API_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger?.warn(`Google People API failed with status ${response.status}`, {
        url: GOOGLE_PEOPLE_API_URL,
        status: response.status,
        body: errorBody,
      });
      return null;
    }

    const data = (await response.json()) as GooglePeopleInfo;

    if (!data.addresses?.length && !data.phoneNumbers?.length) {
      logger?.warn("Google People API returned no addresses or phoneNumbers", {
        url: GOOGLE_PEOPLE_API_URL,
        addresses: data.addresses,
        phoneNumbers: data.phoneNumbers,
      });
    } else {
      logger?.warn("Google People API returned people data", {
        url: GOOGLE_PEOPLE_API_URL,
        addressesCount: data.addresses?.length ?? 0,
        phoneNumbersCount: data.phoneNumbers?.length ?? 0,
      });
    }

    return data;
  } catch (error) {
    logger?.warn("Google People API request threw an exception", error);
    return null;
  }
};

const getGoogleAddressFromPeople = (addresses?: GooglePersonAddress[]) => {
  if (!addresses?.length) return undefined;

  const address =
    addresses.find(
      (item) => item.formattedValue || item.city || item.country,
    ) || addresses[0];

  return compactObject({
    formatted: address.formattedValue,
    street_address: address.streetAddress,
    locality: address.city,
    region: address.region,
    postal_code: address.postalCode,
    country: address.country,
  }) as Record<string, any>;
};

const getGooglePhoneNumberFromPeople = (
  phoneNumbers?: GooglePersonPhoneNumber[],
) => {
  const phone = phoneNumbers?.find((item) => item?.value);
  return phone?.value ? String(phone.value).trim() : undefined;
};

const compactObject = (value: Record<string, any>) =>
  Object.fromEntries(
    Object.entries(value).filter(
      ([, entryValue]) =>
        entryValue !== undefined && entryValue !== null && entryValue !== "",
    ),
  );

const normalizeGoogleGender = (value?: string) => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();

  if (normalized === "male") return "Male";
  if (normalized === "female") return "Female";
  if (normalized) return "other";

  return undefined;
};

const normalizeGoogleBirthdate = (value?: string) => {
  const normalized = String(value ?? "").trim();

  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : undefined;
};

const buildGoogleProfileData = (
  profile: GoogleUserInfo,
  existingUser?: any,
) => {
  const addressFromPeople = getGoogleAddressFromPeople(profile.addresses);
  const address = profile.address || addressFromPeople || null;
  const phoneNumber =
    profile.phone_number ||
    getGooglePhoneNumberFromPeople(profile.phoneNumbers);
  const fullName = profile.name ? String(profile.name).trim() : undefined;
  const city = address?.locality ? String(address.locality).trim() : undefined;
  const country = address?.country ? String(address.country).trim() : undefined;
  const googleProfile = compactObject({
    sub: profile.sub,
    email: profile.email,
    email_verified: profile.email_verified,
    name: profile.name,
    given_name: profile.given_name,
    family_name: profile.family_name,
    picture: profile.picture,
    locale: profile.locale,
    gender: profile.gender,
    birthdate: profile.birthdate,
    phone_number: phoneNumber,
  });

  return compactObject({
    googleLinked: true,
    confirmed: true,
    fullName: existingUser?.fullName || fullName,
    googlePicture: profile.picture,
    googleAddress: address,
    googleProfile,
    city: existingUser?.city || city,
    country: existingUser?.country || country,
    gender: existingUser?.gender || normalizeGoogleGender(profile.gender),
    birthday:
      existingUser?.birthday || normalizeGoogleBirthdate(profile.birthdate),
    phoneNumber: existingUser?.phoneNumber || phoneNumber,
  });
};

export default {
  async login(ctx: any) {
    try {
      const accessToken = String(ctx.request.body?.access_token ?? "").trim();
      if (!accessToken)
        return ctx.badRequest("Google access token is required.");

      const tokenProfile = await verifyGoogleAccessToken(accessToken);
      const userInfo = await fetchGoogleUserInfo(accessToken);
      const peopleInfo = await fetchGooglePeopleInfo(accessToken, strapi?.log);
      const profile = {
        ...tokenProfile,
        ...(userInfo || {}),
        ...(peopleInfo || {}),
      };
      const email = String(profile.email ?? "")
        .trim()
        .toLowerCase();
      const emailVerified =
        profile.email_verified === true || profile.email_verified === "true";
      const expectedClientId =
        process.env.GOOGLE_CLIENT_ID ||
        process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

      if (!email || !emailVerified) {
        return ctx.unauthorized("Google account email is not verified.");
      }

      if (expectedClientId && profile.aud !== expectedClientId) {
        return ctx.unauthorized("Google token was issued for a different app.");
      }

      const existingUsers = await strapi.db.query(userUid).findMany({
        where: { email },
        populate: ["role"],
      });

      let user =
        existingUsers.find(
          (candidate: any) => candidate.provider === "google",
        ) || existingUsers[0];

      if (user?.blocked) {
        return ctx.forbidden(
          "Your account has been blocked by an administrator.",
        );
      }

      if (user) {
        user = await strapi.db.query(userUid).update({
          where: { id: user.id },
          data: {
            accountType: "user",
            ...buildGoogleProfileData(profile, user),
          },
          populate: ["role"],
        });
      } else {
        const advancedSettings = (await strapi
          .store({ type: "plugin", name: "users-permissions", key: "advanced" })
          .get()) as { allow_register?: boolean; default_role?: string } | null;

        if (!advancedSettings?.allow_register) {
          return ctx.forbidden("Register action is currently disabled.");
        }

        const defaultRole = await strapi.db.query(roleUid).findOne({
          where: { type: advancedSettings.default_role },
        });

        if (!defaultRole) {
          return ctx.internalServerError("Default user role was not found.");
        }

        user = await strapi.db.query(userUid).create({
          data: {
            username: await findAvailableUsername(
              strapi,
              profile.name || email.split("@")[0],
            ),
            email,
            accountType: "user",
            provider: "google",
            role: defaultRole.id,
            ...buildGoogleProfileData(profile),
          },
          populate: ["role"],
        });
      }

      const jwt = strapi
        .plugin("users-permissions")
        .service("jwt")
        .issue({ id: user.id });
      ctx.body = {
        jwt,
        user: await sanitizeUser(strapi, user, ctx),
      };
    } catch (error: any) {
      strapi.log.error("Google login failed", error);
      return ctx.badRequest(error?.message || "Google login failed.");
    }
  },
};
