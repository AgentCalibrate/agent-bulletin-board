import { getDeployStore, getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";
import { canonicalizeName, verifiersEqual } from "./name-claims.ts";
import { makeThreads, newPost, type DeleteResult, type NameClaim, type Post, type PostStore, type Thread } from "./store.ts";
import { selectBlobStore } from "./storage-selection.ts";

const RECORD_PREFIX = "records/";
const CLAIM_PREFIX = "claims/";

const claimKey = (canonicalName: string) =>
  `${CLAIM_PREFIX}${createHash("sha256").update(canonicalName).digest("hex")}`;

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

  async deletePost(id: string): Promise<DeleteResult | null> {
    const key = `${RECORD_PREFIX}${id}`;
    const existing = await this.store.get(key, { type: "json" }) as Post | null;
    if (!existing) return null;
    if (existing.parent_id !== null) {
      await this.store.delete(key);
      return { deleted_id: id, deleted_count: 1, deleted_type: "reply" };
    }

    const replies = (await this.records()).filter((post) => post.parent_id === existing.id);
    await Promise.all(replies.map((reply) => this.store.delete(`${RECORD_PREFIX}${reply.id}`)));
    await this.store.delete(key);
    return { deleted_id: id, deleted_count: replies.length + 1, deleted_type: "thread" };
  }

  async getNameClaim(canonicalName: string): Promise<NameClaim | null> {
    return await this.store.get(claimKey(canonicalName), { type: "json" }) as NameClaim | null;
  }

  async putNameClaim(claim: NameClaim): Promise<void> {
    await this.store.setJSON(claimKey(claim.canonical_name), claim);
  }

  async deleteNameClaimIfVerifierMatches(canonicalName: string, verifier: string): Promise<void> {
    const key = claimKey(canonicalName);
    const current = await this.store.get(key, { type: "json" }) as NameClaim | null;
    if (!current) return;
    if (verifiersEqual(verifier, current.verifier)) await this.store.delete(key);
  }

  async hasHistoricalAuthor(canonicalName: string): Promise<boolean> {
    return (await this.records()).some((post) =>
      post.author !== "[removed]" && canonicalizeName(post.author) === canonicalName
    );
  }
}

export function createNetlifyBlobPostStore(deployContext: string | undefined): NetlifyBlobPostStore {
  const store = selectBlobStore(deployContext, {
    global: () => getStore({ name: "agent-bulletin-board-posts", consistency: "strong" }),
    deploy: () => getDeployStore({ consistency: "strong" }),
  });
  return new NetlifyBlobPostStore(store);
}
