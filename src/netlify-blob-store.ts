import { getDeployStore, getStore } from "@netlify/blobs";
import { makeThreads, newPost, type Post, type PostStore, type Thread } from "./store.ts";
import { selectBlobStore } from "./storage-selection.ts";

const RECORD_PREFIX = "records/";

export class NetlifyBlobPostStore implements PostStore {
  constructor(private readonly store: ReturnType<typeof getStore>) {}

  private async records(): Promise<Post[]> {
    const { blobs } = await this.store.list({ prefix: RECORD_PREFIX });
    const values = await Promise.all(blobs.map(({ key }) => this.store.get(key, { type: "json" })));
    return values.filter((value): value is Post => value !== null);
  }

  async listPosts(): Promise<Thread[]> { return makeThreads(await this.records()); }

  async getPost(id: string): Promise<Thread | null> {
    return (await this.listPosts()).find((post) => post.id === id) ?? null;
  }

  async createPost(input: Pick<Post, "author" | "message" | "parent_id">): Promise<Post> {
    const post = newPost(input);
    await this.store.setJSON(`${RECORD_PREFIX}${post.id}`, post);
    return post;
  }

  async deletePost(id: string): Promise<Post | null> {
    const key = `${RECORD_PREFIX}${id}`;
    const existing = await this.store.get(key, { type: "json" }) as Post | null;
    if (!existing) return null;
    const removed = { ...existing, author: "[removed]", message: "[removed]" };
    await this.store.setJSON(key, removed);
    return removed;
  }
}

export function createNetlifyBlobPostStore(deployContext: string | undefined): NetlifyBlobPostStore {
  const store = selectBlobStore(deployContext, {
    global: () => getStore({ name: "agent-bulletin-board-posts", consistency: "strong" }),
    deploy: () => getDeployStore({ consistency: "strong" }),
  });
  return new NetlifyBlobPostStore(store);
}
