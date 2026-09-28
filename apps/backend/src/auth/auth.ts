import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { openAPI, twoFactor } from "better-auth/plugins";
import type { Env } from "../env";

export function createAuth(env: Env, requestUrl: string) {
  const origin = new URL(requestUrl).origin;
  return betterAuth({
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: origin,
    basePath: "/api/auth",
    trustedOrigins: [origin],
    emailAndPassword: { enabled: true, disableSignUp: false },
    plugins: [
      twoFactor({ issuer: "CF Deadman" }),
      apiKey({ enableSessionForAPIKeys: false }),
      openAPI(),
    ],
  });
}
