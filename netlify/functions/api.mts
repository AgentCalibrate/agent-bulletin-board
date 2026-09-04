import type { Config, Context } from "@netlify/functions";
import { createApi } from "../../src/api.ts";
import { createNetlifyBlobPostStore } from "../../src/netlify-blob-store.ts";

export default async function handler(request: Request, _context: Context): Promise<Response> {
  // Runtime-bound state is resolved per invocation, never while this module is imported.
  const store = createNetlifyBlobPostStore(Netlify.env.get("CONTEXT"));
  return createApi(store, () => Netlify.env.get("ADMIN_DELETE_TOKEN"))(request);
}

export const config: Config = { path: ["/api", "/api/*", "/feed.json"] };
