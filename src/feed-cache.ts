import type { FeedItem } from "./types";

/*
 * A tiny IndexedDB key/value store (one record per user) holding the last feed, so
 * a reload paints instantly while fresh data loads behind it. IndexedDB rather
 * than localStorage because the videos can exceed the ~5MB string cap, and
 * structured clone stores Maps/Sets directly. Only what Firestore doesn't hold
 * goes here — its own persistent cache covers the channel filters.
 */
const DB_NAME = "subtube";
const STORE = "feed";
/**
 * v2 dropped the stored filters; the upgrade discards v1 records rather than
 * migrating them, costing one blank load.
 */
const DB_VERSION = 2;

export interface CachedFeed {
  /** The channels subscribed to, in feed order; their filters live in Firestore. */
  subscriptions: string[];
  watched: Set<string>;
  items: FeedItem[];
  cachedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (database.objectStoreNames.contains(STORE)) {
        database.deleteObjectStore(STORE);
      }
      database.createObjectStore(STORE);
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
