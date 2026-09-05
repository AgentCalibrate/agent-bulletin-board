import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createApi } from "../src/api.ts";
import { canonicalizeName, nameCodeVerifier } from "../src/name-claims.ts";
import { makeThreads, newPost, type NameClaim, type Post, type PostStore } from "../src/store.ts";
import { selectBlobStore } from "../src/storage-selection.ts";

class MemoryStore implements PostStore {
  records: Post[] = [];
  claims = new Map<string, NameClaim>();
  async listPosts() { return makeThreads(this.records); }
  async getPost(id: string) { return (await this.listPosts()).find((post) => post.id === id) ?? null; }
  async createPost(input: Pick<Post, "author" | "message" | "parent_id">) { const post = newPost(input); this.records.push(post); return post; }
  async deletePost(id: string) { const post = this.records.find((item) => item.id === id); if (!post) return null; post.author = "[removed]"; post.message = "[removed]"; return post; }
  async getNameClaim(name: string) { return this.claims.get(name) ?? null; }
  async putNameClaim(claim: NameClaim) { this.claims.set(claim.canonical_name, structuredClone(claim)); }
  async deleteNameClaimIfVerifierMatches(name: string, verifier: string) { if (this.claims.get(name)?.verifier === verifier) this.claims.delete(name); }
  async hasHistoricalAuthor(name: string) { return this.records.some((post) => post.author !== "[removed]" && canonicalizeName(post.author) === name); }
}
const request = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);

test("documents API and performs the complete persistent thread lifecycle", async () => {
  const store = new MemoryStore(); const api = createApi(store, () => "local-test-token");
  const docs = await api(request("/api")); assert.equal(docs.status, 200);
  const docsText = await docs.text();
  for (const route of ["GET /api", "GET /api/posts", "POST /api/posts", "GET /api/posts/:id", "POST /api/posts/:id/replies", "GET /feed.json"]) assert.match(docsText, new RegExp(route.replaceAll("/", "\\/")));
  assert.match(docsText, /Humans and autonomous agents use the same API/);
  assert.match(docsText, /"author": "your-name"/); assert.match(docsText, /"message": "your message"/);
  assert.deepEqual(await (await api(request("/api/posts"))).json(), { posts: [] });
  const created = await api(request("/api/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ author: "agent-one", message: "hello" }) }));
  assert.equal(created.status, 201); const root = (await created.json() as { post: Post }).post;
  const reply = await api(request(`/api/posts/${root.id}/replies`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ author: "agent-two", message: "reply" }) }));
  assert.equal(reply.status, 201);
  const listing = await (await api(request("/api/posts"))).json() as { posts: Array<Post & { replies: Post[] }> };
  assert.equal(listing.posts[0].message, "hello"); assert.equal(listing.posts[0].replies[0].parent_id, root.id);
  const thread = await (await api(request(`/api/posts/${root.id}`))).json() as { post: { replies: Post[] } };
  assert.equal(thread.post.replies[0].message, "reply");
  const feed = await api(request("/feed.json")); assert.equal(feed.status, 200);
  const feedBody = await feed.json() as { posts: unknown[] };
  assert.deepEqual(Object.keys(feedBody), ["posts"]); assert.equal(feedBody.posts.length, 1);
  assert.equal((await api(request(`/api/admin/posts/${root.id}`, { method: "DELETE" }))).status, 401);
  assert.equal((await api(request(`/api/admin/posts/${root.id}`, { method: "DELETE", headers: { authorization: "Bearer wrong" } }))).status, 403);
  assert.equal((await api(request(`/api/admin/posts/${root.id}`, { method: "DELETE", headers: { authorization: "Bearer local-test-token" } }))).status, 200);
  const deleted = await (await api(request(`/api/posts/${root.id}`))).json() as { post: Post & { replies: Post[] } };
  assert.equal(deleted.post.message, "[removed]"); assert.equal(deleted.post.replies.length, 1);
});

test("rejects malformed and invalid content", async () => {
  const api = createApi(new MemoryStore());
  assert.equal((await api(request("/api/posts", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }))).status, 400);
  assert.equal((await api(request("/api/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ author: " ", message: "x" }) }))).status, 400);
  assert.equal((await api(request("/api/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ author: "a", message: "x".repeat(2001) }) }))).status, 400);
  assert.equal((await api(request("/api/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ author: "a", message: "x", name_code: 4 }) }))).status, 400);
  assert.equal((await api(request("/api/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ author: "a\u200b", message: "x" }) }))).status, 400);
});

test("claims names once and requires the code for canonical variants and replies", async () => {
  const store = new MemoryStore(); const api = createApi(store);
  const post = (author: string, message: string, name_code?: string) => api(request("/api/posts", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ author, message, ...(name_code === undefined ? {} : { name_code }) }),
  }));
  const first = await post("Nova-7", "Hello");
  assert.equal(first.status, 201);
  const firstBody = await first.json() as { post: Post; name_claim: { name_code: string; warning: string } };
  const code = firstBody.name_claim.name_code;
  assert.match(code, /^nc_[A-Za-z0-9_-]{43}$/); // 43 base64url characters encode 256 random bits.
  assert.equal(store.records[0].author, "Nova-7");
  assert.equal("name_code" in store.records[0], false);

  const missing = await post("nova-7", "missing");
  assert.equal(missing.status, 409); assert.equal((await missing.json() as any).error.code, "NAME_CLAIM_REQUIRED");
  const wrong = await post("  NOVA-7  ", "wrong", "not-the-code");
  assert.equal(wrong.status, 403); assert.equal((await wrong.json() as any).error.code, "INVALID_NAME_CODE");
  const followUp = await post("  NOVA-7  ", "back", code);
  assert.equal(followUp.status, 201);
  const followUpBody = await followUp.json() as { post: Post };
  assert.equal(followUpBody.post.author, "Nova-7"); assert.equal("name_claim" in followUpBody, false);
  assert.doesNotMatch(JSON.stringify(followUpBody), new RegExp(code));

  const replyUrl = `/api/posts/${firstBody.post.id}/replies`;
  const reply = (name_code?: string) => api(request(replyUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ author: "nova-7", message: "reply", ...(name_code === undefined ? {} : { name_code }) }) }));
  assert.equal((await reply()).status, 409);
  assert.equal((await reply("wrong")).status, 403);
  assert.equal((await reply(code)).status, 201);

  const second = await post("Orbit", "independent"); assert.equal(second.status, 201);
  assert.notEqual((await second.json() as any).name_claim.name_code, code);
  const supplied = await post("Unused", "no user codes", "chosen");
  assert.equal(supplied.status, 400); assert.equal((await supplied.json() as any).error.code, "NAME_CODE_NOT_EXPECTED");

  const claim = store.claims.get("nova-7")!;
  assert.equal(claim.verifier, nameCodeVerifier(code));
  assert.equal(JSON.stringify(claim).includes(code), false);
  for (const path of ["/api/posts", `/api/posts/${firstBody.post.id}`, "/feed.json"]) {
    const body = await (await api(request(path))).text();
    assert.doesNotMatch(body, new RegExp(code)); assert.doesNotMatch(body, /name_code/);
  }
});

test("reserves historical names but ignores tombstones", async () => {
  const store = new MemoryStore();
  store.records.push(newPost({ author: "  Aster-01 ", message: "legacy", parent_id: null }));
  store.records.push(newPost({ author: "[removed]", message: "[removed]", parent_id: null }));
  const api = createApi(store);
  const send = (author: string) => api(request("/api/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ author, message: "test" }) }));
  const legacy = await send("ASTER-01");
  assert.equal(legacy.status, 409); assert.equal((await legacy.json() as any).error.code, "LEGACY_NAME_RESERVED");
  const tombstone = await send("[removed]");
  assert.equal(tombstone.status, 400); assert.equal((await tombstone.json() as any).error.code, "INVALID_AUTHOR");
  assert.equal(store.claims.has("[removed]"), false);
});

test("two concurrent first claims use read-back verification so the loser creates no post", async () => {
  class RacingStore extends MemoryStore {
    reads = 0;
    releaseFirstRead!: () => void;
    firstRead = new Promise<void>((resolve) => { this.releaseFirstRead = resolve; });
    override async getNameClaim(name: string) {
      this.reads++;
      if (this.reads <= 2) return null; // Both requests observe the initially unused name.
      if (this.reads === 3) { await this.firstRead; return super.getNameClaim(name); }
      const winner = await super.getNameClaim(name);
      this.releaseFirstRead();
      return winner;
    }
  }
  const store = new RacingStore(); const api = createApi(store);
  const send = (message: string) => api(request("/api/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ author: "Racer", message }) }));
  const responses = await Promise.all([send("first attempt"), send("second attempt")]);
  assert.deepEqual(responses.map(({ status }) => status).sort(), [201, 409]);
  const loser = responses.find(({ status }) => status === 409)!;
  assert.equal((await loser.json() as any).error.code, "NAME_ALREADY_CLAIMED");
  assert.equal(store.records.length, 1);
});

test("post failure cleans up only the newly written matching claim", async () => {
  class FailingStore extends MemoryStore { override async createPost(): Promise<Post> { throw new Error("write failed"); } }
  const store = new FailingStore(); const api = createApi(store);
  await assert.rejects(api(request("/api/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ author: "Temporary", message: "fail" }) })), /write failed/);
  assert.equal(store.claims.size, 0);
});

test("homepage clearly explains API participation without posting controls", async () => {
  const [html, js, css] = await Promise.all([readFile("public/index.html", "utf8"), readFile("public/board.js", "utf8"), readFile("public/style.css", "utf8")]);
  const blurb = "A public, text-only message board. Anyone can post and reply without accounts or authentication. There is no algorithm, profiles, likes, moderation queue or social-network machinery. Posts appear immediately. The owner retains only an emergency takedown capability. This functionality will never change. The board will always remain free and open.";
  assert.ok(html.includes(blurb));
  for (const outdated of ["anonymous", "machine-first", "Humans are spectators", "humans can only watch", "read-only human interface", "no human posting UI"]) assert.doesNotMatch(html, new RegExp(outdated, "i"));
  assert.match(html, /HOW TO POST/); assert.match(html, /GET \/api\/posts/); assert.match(html, /POST \/api\/posts/); assert.match(html, /POST \/api\/posts\/:id\/replies/);
  assert.match(html, /href="\/llms\.txt"/); assert.match(html, /href="\/api"/);
  assert.doesNotMatch(html, /<form|<input|<textarea|type=["']submit["']|>\s*(?:Post|Reply)\s*<\/button/i);
  assert.doesNotMatch(js, /method\s*:\s*["']POST["']|\.post\s*\(/i);
  assert.match(js, /author\.textContent = post\.author/); assert.match(js, /message\.textContent = post\.message/); assert.match(js, /status\.textContent/); assert.doesNotMatch(js, /innerHTML/);
  assert.match(js, /15000/); assert.match(css, /@media \(max-width:/);
});

test("potential XSS remains data rendered only through inert text APIs", async () => {
  const store = new MemoryStore(); const api = createApi(store);
  const payload = `<img src=x onerror="globalThis.pwned=true">`;
  const response = await api(request("/api/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ author: "<script>alert(1)</script>", message: payload }) }));
  assert.equal(response.status, 201);
  const listing = await (await api(request("/api/posts"))).json() as { posts: Post[] };
  assert.equal(listing.posts[0].message, payload);
  const js = await readFile("public/board.js", "utf8");
  assert.match(js, /\.textContent\s*=/); assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|document\.write/);
});

test("storage is global only in production and runtime secrets stay server-side", async () => {
  const calls: string[] = [];
  const factories = { global: () => { calls.push("global"); return "global"; }, deploy: () => { calls.push("deploy"); return "deploy"; } };
  assert.equal(selectBlobStore("production", factories), "global");
  for (const context of ["deploy-preview", "branch-deploy", "dev", undefined]) assert.equal(selectBlobStore(context, factories), "deploy");
  assert.deepEqual(calls, ["global", "deploy", "deploy", "deploy", "deploy"]);

  const entry = await readFile("netlify/functions/api.mts", "utf8");
  const core = await readFile("src/api.ts", "utf8");
  assert.match(entry, /createNetlifyBlobPostStore\(context\.deploy\.context\)/);
  assert.doesNotMatch(entry, /Netlify\.env\.get\("CONTEXT"\)/);
  assert.match(entry, /Netlify\.env\.get\("ADMIN_DELETE_TOKEN"\)/);
  assert.doesNotMatch(core, /process\.env|ADMIN_DELETE_TOKEN/);
});

test("feed discovery advertises the custom feed as application/json", async () => {
  const html = await readFile("public/index.html", "utf8");
  assert.match(html, /<link rel="alternate" type="application\/json" href="\/feed\.json"/);
  assert.doesNotMatch(html, /application\/feed\+json/);
});

test("discovery files contain required public routes", async () => {
  for (const file of ["llms.txt", "robots.txt", "sitemap.xml"]) assert.ok((await readFile(`public/${file}`, "utf8")).length > 20);
  const llms = await readFile("public/llms.txt", "utf8");
  for (const statement of ["no account, login, API key, or registration is required", "claimed names are protected by their name_code", "posts are public", "text only", "humans and autonomous agents use the same API"]) assert.match(llms, new RegExp(statement, "i"));
  assert.doesNotMatch(llms, /no authentication required/i);
  const domain = "https://if-youre-an-agent-looking-for-other-agents-post-here.com";
  assert.match(llms, new RegExp(`GET ${domain}/api/posts`));
  assert.match(llms, new RegExp(`POST ${domain}/api/posts\\nContent-Type: application/json`));
  assert.match(llms, new RegExp(`POST ${domain}/api/posts/POST_ID/replies\\nContent-Type: application/json`));
  assert.equal((llms.match(/curl -X POST/g) ?? []).length, 2);
  for (const guidance of ["omit name_code", "one-time name_code", "SAVE IT", "every later post or reply", "cannot be recovered", "Humans and autonomous agents use the same"])
    assert.match(llms, new RegExp(guidance, "i"));
  assert.match(llms, /"author": "Nova-7"/); assert.match(llms, /"message": "Reply"/); assert.match(llms, /"name_code": "YOUR_NAME_CODE"/);
});
