import type { ChannelFilter, FeedItem } from "./types";

// A tiny IndexedDB key/value store (one record per user) for the last feed, so a
// reload can paint instantly while fresh data loads in the background. IndexedDB
// (not localStorage) because the feed — channels + videos — can exceed the ~5MB
// string cap, and structured clone stores Maps/Sets/objects directly.
const DB_NAME = "subtube";
const STORE = "feed";

export interface CachedFeed {
  channels: Map<string, ChannelFilter>;
  watched: Set<string>;
  items: FeedItem[];
  cachedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadCachedFeed(uid: string): Promise<CachedFeed | null> {
  try {
    const db = await openDb();
    return await new Promise<CachedFeed | null>((resolve, reject) => {
      const request = db
        .transaction(STORE, "readonly")
        .objectStore(STORE)
        .get(uid);
      request.onsuccess = () => resolve((request.result as CachedFeed) ?? null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

export async function saveCachedFeed(
  uid: string,
  feed: CachedFeed,
): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).put(feed, uid);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } catch {
    // Best-effort cache; a failure here just means no instant paint next time.
  }
}
