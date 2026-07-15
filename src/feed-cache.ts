import { withVerdicts } from "./feed-item";
import type { ChannelFilter, FeedItem } from "./types";

/*
 * A tiny IndexedDB key/value store (one record per user) holding the last feed, so
 * a reload paints instantly while fresh data loads behind it. IndexedDB rather
 * than localStorage because the videos can exceed the ~5MB string cap, and
 * structured clone stores Maps/Sets directly. The channel filters ride along so a
 * reload filters the cached feed on the first frame, without waiting on a read.
 */
const DB_NAME = "subtube";
const STORE = "feed";
/**
 * v3 restored the stored filters (the feed reverted to a one-time filter load);
 * each bump discards older records rather than migrating, costing one blank load.
 */
const DB_VERSION = 3;

export interface CachedFeed {
  /** The subscribed channels with their filters, so a reload paints already filtered. */
  channels: Map<string, ChannelFilter>;
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

/**
 * Fold Shorts verdicts into the cached feed as they arrive. They land after the
 * load that saved it, so a cache that never learned them paints those videos as
 * unclassified — and an unclassified video is always shown, so the next reload
 * would flash a dropped Short into the feed and back out again once the verdict
 * re-arrived. Short-ness never changes, so a stored verdict never goes stale.
 */
export async function cacheShortsVerdicts(
  uid: string,
  verdicts: Map<string, boolean>,
): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      // One transaction for the read and the write, so a whole-feed save can't
      // land between them and be overwritten by what it replaced.
      const transaction = db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      const request = store.get(uid);
      request.onsuccess = () => {
        const cached = request.result as CachedFeed | undefined;
        if (!cached) {
          return;
        }
        const items = withVerdicts(cached.items, verdicts);
        if (items !== cached.items) {
          store.put({ ...cached, items }, uid);
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } catch {
    // Best-effort; the next full save carries these verdicts anyway.
  }
}
