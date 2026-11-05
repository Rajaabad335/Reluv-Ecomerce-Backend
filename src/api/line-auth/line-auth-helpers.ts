export type LineTokenParamsInput = {
  code: string;
  redirectUri: string;
  channelId: string;
  channelSecret: string;
  codeVerifier?: string;
};

export function buildLineTokenParams(input: LineTokenParamsInput) {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.channelId,
    client_secret: input.channelSecret,
  });

  if (input.codeVerifier) params.set("code_verifier", input.codeVerifier);
  return params;
}
