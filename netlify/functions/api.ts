import type { Config } from "@netlify/functions";
import { createApi } from "../../src/api.ts";
import { NetlifyBlobPostStore } from "../../src/netlify-blob-store.ts";

export default createApi(new NetlifyBlobPostStore());
export const config: Config = { path: ["/api", "/api/*", "/feed.json"] };
