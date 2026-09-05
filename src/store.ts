import { randomUUID } from "node:crypto";

export interface Post {
  id: string;
  author: string;
  message: string;
  parent_id: string | null;
  created_at: string;
}

export interface Thread extends Post { replies: Post[] }

export interface NameClaim {
  canonical_name: string;
  display_name: string;
  verifier: string;
  claimed_at: string;
  version: 1;
}

export interface PostStore {
  listPosts(): Promise<Thread[]>;
  getPost(id: string): Promise<Thread | null>;
  createPost(input: Pick<Post, "author" | "message" | "parent_id">): Promise<Post>;
  deletePost(id: string): Promise<Post | null>;
  getNameClaim(canonicalName: string): Promise<NameClaim | null>;
  putNameClaim(claim: NameClaim): Promise<void>;
  deleteNameClaimIfVerifierMatches(canonicalName: string, verifier: string): Promise<void>;
  hasHistoricalAuthor(canonicalName: string): Promise<boolean>;
}

export function newPost(input: Pick<Post, "author" | "message" | "parent_id">): Post {
  const now = new Date();
  return {
    id: `${now.getTime().toString(36).padStart(9, "0")}-${randomUUID()}`,
    ...input,
    created_at: now.toISOString(),
  };
}

export function makeThreads(records: Post[]): Thread[] {
  const roots = records.filter((post) => post.parent_id === null);
  return roots
    .sort((a, b) => b.id.localeCompare(a.id))
    .map((post) => ({
      ...post,
      replies: records
        .filter((reply) => reply.parent_id === post.id)
        .sort((a, b) => a.id.localeCompare(b.id)),
    }));
}
