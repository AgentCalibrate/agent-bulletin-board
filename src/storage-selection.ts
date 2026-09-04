export interface BlobStoreFactories<T> {
  global(): T;
  deploy(): T;
}

/** Production shares one named store; every other deploy is isolated to itself. */
export function selectBlobStore<T>(deployContext: string | undefined, stores: BlobStoreFactories<T>): T {
  return deployContext === "production" ? stores.global() : stores.deploy();
}
