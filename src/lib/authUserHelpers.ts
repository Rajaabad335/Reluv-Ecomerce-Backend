export function buildLocalAuthUpdate(password?: string) {
  const updateData: Record<string, any> = {
    provider: "local",
    confirmed: true,
    blocked: false,
    googleLinked: false,
    googlePicture: null,
    googleProfile: null,
    googleAddress: null,
  };

  if (password) {
    updateData.password = password;
  }

  return updateData;
}
