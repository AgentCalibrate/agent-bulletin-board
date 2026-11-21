import assert from "node:assert/strict";
import test from "node:test";
import { NetlifyBlobPostStore } from "../src/netlify-blob-store.ts";
import type { Post } from "../src/store.ts";

const id = (n: number) => String(n).padStart(9, "0") + "-00000000-0000-4000-8000-" + n.toString(16).padStart(12, "0");
const record = (n: number, parent_id: string | null = null): Post => ({
  id: id(n), author: n === 1003 ? "Late Author" : "guest", message: "record " + n,
  parent_id, created_at: new Date(1700000000000 + n).toISOString(),
});

class MultiPageBlobStore {
  readonly blobs = new Map<string, Post>();
  listingPages = 0;
  constructor(records: Post[]) {
    for (const post of records) this.blobs.set("records/" + post.id, post);
  }
  async list(options: { prefix?: string; paginate?: boolean }) {
    assert.deepEqual(options, { prefix: "records/" });
    const keys = [...this.blobs.keys()].filter((key) => key.startsWith(options.prefix ?? ""));
    // Simulate the SDK's default automatic aggregation of successive server pages.
    const pages: string[][] = [];
    for (let i = 0; i < keys.length; i += 1000) pages.push(keys.slice(i, i + 1000));
    this.listingPages = pages.length;
    return { blobs: pages.flatMap((page) => page.map((key) => ({ key, etag: "etag" }))), directories: [] };
  }
  async get(key: string, options: { type: string }) {
    assert.deepEqual(options, { type: "json" });
    return this.blobs.get(key) ?? null;
  }
  async setJSON(key: string, value: Post) { this.blobs.set(key, value); }
  async delete(key: string) { this.blobs.delete(key); }
}

test("multi-page Blob listings preserve all posts, thread/reply lookup and historic names", async () => {
  const rootRecords = Array.from({ length: 1005 }, (_, i) => record(i + 1));
  const reply = record(10006, id(1003));
  const fake = new MultiPageBlobStore([...rootRecords, reply]);
  const store = new NetlifyBlobPostStore(fake as unknown as ConstructorParameters<typeof NetlifyBlobPostStore>[0]);

  const threads = await store.listPosts();
  assert.equal(fake.listingPages, 2);
  assert.equal(threads.length, 1005);
  assert.equal(threads[0].id, id(1005));
  const late = await store.getPost(id(1003));
  assert.equal(late?.replies.length, 1);
  assert.equal(late?.replies[0].id, reply.id);
  assert.equal(await store.hasHistoricalAuthor("late author"), true);

  const deleted = await store.deletePost(id(1003));
  assert.deepEqual(deleted, { deleted_id: id(1003), deleted_count: 2, deleted_type: "thread" });
  assert.equal(fake.blobs.has("records/" + id(1003)), false);
  assert.equal(fake.blobs.has("records/" + reply.id), false);
  assert.equal(fake.blobs.has("records/" + id(1005)), true);
  assert.equal((await store.listPosts()).length, 1004);
});

test("deleting a reply past the first Blob page does not delete its parent", async () => {
  const fake = new MultiPageBlobStore([
    ...Array.from({ length: 1001 }, (_, i) => record(i + 1)),
    record(20000, id(1001)),
  ]);
  const store = new NetlifyBlobPostStore(fake as unknown as ConstructorParameters<typeof NetlifyBlobPostStore>[0]);
  assert.deepEqual(await store.deletePost(id(20000)), {
    deleted_id: id(20000), deleted_count: 1, deleted_type: "reply",
  });
  assert.equal(fake.blobs.has("records/" + id(1001)), true);
  assert.equal((await store.getPost(id(1001)))?.replies.length, 0);
});
