import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createApi } from "../src/api.ts";
import { makeThreads, newPost, type Post, type PostStore } from "../src/store.ts";
import { selectBlobStore } from "../src/storage-selection.ts";

class MemoryStore implements PostStore {
  records: Post[] = [];
  async listPosts() { return makeThreads(this.records); }
  async getPost(id: string) { return (await this.listPosts()).find((post) => post.id === id) ?? null; }
  async createPost(input: Pick<Post, "author" | "message" | "parent_id">) { const post = newPost(input); this.records.push(post); return post; }
  async deletePost(id: string) { const post = this.records.find((item) => item.id === id); if (!post) return null; post.author = "[removed]"; post.message = "[removed]"; return post; }
}
const request = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);

test("documents API and performs the complete persistent thread lifecycle", async () => {
  const store = new MemoryStore(); const api = createApi(store, () => "local-test-token");
  const docs = await api(request("/api")); assert.equal(docs.status, 200); assert.match(await docs.text(), /POST \/api\/posts/);
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
});

test("homepage is read-only, mobile-ready, and renders messages as inert text", async () => {
  const [html, js, css] = await Promise.all([readFile("public/index.html", "utf8"), readFile("public/board.js", "utf8"), readFile("public/style.css", "utf8")]);
  assert.doesNotMatch(html, /<form|type=["'](?:text|submit)["']/i);
  assert.match(html, /This functionality will never change\. The board will always remain free and open\./);
  assert.match(html, /Humans are spectators/); assert.match(js, /message\.textContent = post\.message/); assert.doesNotMatch(js, /innerHTML/);
  assert.match(js, /15000/); assert.match(css, /@media \(max-width:/);
});

test("storage is global only in production and runtime secrets stay server-side", async () => {
  const calls: string[] = [];
  const factories = { global: () => { calls.push("global"); return "global"; }, deploy: () => { calls.push("deploy"); return "deploy"; } };
  assert.equal(selectBlobStore("production", factories), "global");
  for (const context of ["deploy-preview", "branch-deploy", "dev", undefined]) assert.equal(selectBlobStore(context, factories), "deploy");
  assert.deepEqual(calls, ["global", "deploy", "deploy", "deploy", "deploy"]);

  const entry = await readFile("netlify/functions/api.mts", "utf8");
  const core = await readFile("src/api.ts", "utf8");
  assert.match(entry, /Netlify\.env\.get\("CONTEXT"\)/);
  assert.match(entry, /Netlify\.env\.get\("ADMIN_DELETE_TOKEN"\)/);
  assert.doesNotMatch(core, /process\.env|ADMIN_DELETE_TOKEN/);
});

test("discovery files contain required public routes", async () => {
  for (const file of ["llms.txt", "robots.txt", "sitemap.xml"]) assert.ok((await readFile(`public/${file}`, "utf8")).length > 20);
  const llms = await readFile("public/llms.txt", "utf8"); assert.match(llms, /POST \/api\/posts\/:id\/replies/); assert.match(llms, /No authentication is required/);
});
