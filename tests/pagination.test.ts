import assert from "node:assert/strict";
import test from "node:test";
import { createApi } from "../src/api.ts";
import { makeThreads, type Post, type PostStore } from "../src/store.ts";

const id = (n: number) => String(n).padStart(9, "0") + "-00000000-0000-4000-8000-" + n.toString(16).padStart(12, "0");
const post = (n: number, parent: string | null = null): Post => ({
  id: id(n), author: "reader", message: "message " + n,
  parent_id: parent, created_at: new Date(1700000000000 + n).toISOString(),
});

class ReadStore implements PostStore {
  readonly records: Post[];
  constructor(records: Post[]) { this.records = records; }
  async listPosts() { return makeThreads(this.records); }
  async getPost(key: string) { return (await this.listPosts()).find((p) => p.id === key) ?? null; }
  async createPost(): Promise<Post> { throw new Error("unexpected write"); }
  async deletePost() { throw new Error("unexpected delete"); }
  async getNameClaim() { return null; }
  async putNameClaim() { throw new Error("unexpected claim"); }
  async deleteNameClaimIfVerifierMatches() { throw new Error("unexpected claim delete"); }
  async hasHistoricalAuthor() { return false; }
}

const request = (path: string) => new Request("http://localhost" + path);
const roots = Array.from({ length: 57 }, (_, i) => post(i + 1));
const replies = [1, 20, 57].flatMap((n) => [post(n + 10000, id(n)), post(n + 20000, id(n))]);
const fixture = () => createApi(new ReadStore([...roots, ...replies]));

test("unparameterized listing is backward compatible and feed retains 50 threads", async () => {
  const api = fixture();
  const legacy = await api(request("/api/posts"));
  assert.equal(legacy.status, 200);
  const body = await legacy.json() as { posts: Array<Post & { replies: Post[] }> };
  assert.deepEqual(Object.keys(body), ["posts"]);
  assert.equal(body.posts.length, 57);
  assert.deepEqual(body.posts.map((p) => p.id), roots.map((p) => p.id).reverse());
  assert.equal(body.posts.find((p) => p.id === id(57))?.replies.length, 2);
  const feed = await (await api(request("/feed.json"))).json() as { posts: Post[] };
  assert.equal(feed.posts.length, 50);
  assert.deepEqual(Object.keys(feed), ["posts"]);
});

test("limit/before returns deterministic complete pages and next_before traverses all history", async () => {
  const api = fixture();
  let path = "/api/posts?limit=20";
  const collected: string[] = [];
  const observedReplies = new Set<string>();
  for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
    const response = await api(request(path));
    assert.equal(response.status, 200);
    const page = await response.json() as { posts: Array<Post & { replies: Post[] }>; next_before?: string };
    assert.ok(page.posts.length > 0 && page.posts.length <= 20);
    for (const thread of page.posts) {
      collected.push(thread.id);
      if ([id(1), id(20), id(57)].includes(thread.id)) {
        assert.equal(thread.replies.length, 2);
        observedReplies.add(thread.id);
      }
    }
    if (page.next_before === undefined) {
      assert.equal(pageNumber, 2);
      assert.equal(page.posts.length, 17);
      break;
    }
    assert.equal(page.next_before, page.posts[page.posts.length - 1].id);
    path = "/api/posts?limit=20&before=" + page.next_before;
  }
  assert.deepEqual(collected, roots.map((p) => p.id).reverse());
  assert.equal(new Set(collected).size, 57);
  assert.equal(observedReplies.size, 3);
  const afterEnd = await (await api(request("/api/posts?limit=20&before=" + id(1)))).json() as { posts: Post[]; next_before?: string };
  assert.deepEqual(afterEnd, { posts: [] });
  const allInOnePage = await (await api(request("/api/posts?limit=999999"))).json() as { posts: Post[]; next_before?: string };
  assert.equal(allInOnePage.posts.length, 57);
  assert.equal(allInOnePage.next_before, undefined);
});

test("invalid and duplicate pagination parameters return explicit HTTP 400", async () => {
  const api = fixture();
  for (const search of [
    "limit=", "limit=0", "limit=-1", "limit=2.1", "limit=abc", "limit=1e2",
    "limit=9007199254740992", "limit=20&limit=30", "before=" + id(20),
    "limit=20&before=", "limit=20&before=nope", "limit=20&before=" + id(20) + "&before=" + id(19),
    "limit=20&after=" + id(20),
  ]) {
    const response = await api(request("/api/posts?" + search));
    assert.equal(response.status, 400, search);
    const body = await response.json() as { error: { code: string; message: string } };
    assert.equal(body.error.code, "INVALID_PAGINATION", search);
    assert.ok(body.error.message.length > 0, search);
  }
});
