import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  documentId,
  getDocs,
  onSnapshot,
  type QuerySnapshot,
  query,
  setDoc,
  type Unsubscribe,
  where,
} from "firebase/firestore";
import { firebaseApp, firestoreDb } from "./firebase-app";
import type { ChannelFilter, Subscription } from "./types";
import { clearToken } from "./youtube-token";

/**
 * Sign in for identity only. YouTube authorization is a separate Authorization
 * Code flow (see youtube-auth.ts), handled server-side so we get a refresh token.
 */
export async function signIn(): Promise<void> {
  const provider = new GoogleAuthProvider();
  await signInWithPopup(getAuth(firebaseApp()), provider);
}

export async function signOutUser(): Promise<void> {
  clearToken();
  await signOut(getAuth(firebaseApp()));
}

export function watchAuth(callback: (user: User | null) => void): () => void {
  return onAuthStateChanged(getAuth(firebaseApp()), callback);
}

function channelsCollection(userId: string) {
  return collection(firestoreDb(), "users", userId, "channels");
}

function watchedCollection(userId: string) {
  return collection(firestoreDb(), "users", userId, "watched");
}

function toFilterMap(snapshot: QuerySnapshot): Map<string, ChannelFilter> {
  const filters = new Map<string, ChannelFilter>();
  snapshot.forEach((document) => {
    filters.set(document.id, document.data() as ChannelFilter);
  });
  return filters;
}

/**
 * Live view of the stored channel filters, including channels no longer
 * subscribed to (the caller narrows to the current subscriptions). Firestore
 * replays a local write to this listener as it's issued, so an edit never races a
 * point-in-time read.
 *
 * `synced` distinguishes a snapshot the server has confirmed from one served out
 * of the local cache, which may predate filters written on another device.
 * Metadata changes are included so the confirmation arrives even when the server
 * turns out to agree with the cache.
 */
export function watchChannelFilters(
  userId: string,
  onFilters: (filters: Map<string, ChannelFilter>, synced: boolean) => void,
): Unsubscribe {
  return onSnapshot(
    channelsCollection(userId),
    { includeMetadataChanges: true },
    (snapshot) => {
      onFilters(toFilterMap(snapshot), !snapshot.metadata.fromCache);
    },
  );
}

export async function loadChannelFilters(
  userId: string,
): Promise<Map<string, ChannelFilter>> {
  return toFilterMap(await getDocs(channelsCollection(userId)));
}

export async function saveChannelFilter(
  userId: string,
  filter: ChannelFilter,
): Promise<void> {
  await setDoc(doc(channelsCollection(userId), filter.channelId), filter);
}

/**
 * Refresh only the fields YouTube owns, leaving the ones the user owns alone. A
 * whole-document write here would revert a filter edit made while the load that
 * read this channel was still running.
 */
async function saveChannelIdentity(
  userId: string,
  channelId: string,
  identity: Pick<ChannelFilter, "title" | "thumbnail">,
): Promise<void> {
  await setDoc(doc(channelsCollection(userId), channelId), identity, {
    merge: true,
  });
}

/**
 * Reconcile stored filters against the live subscriptions: create defaults for
 * newly seen channels and refresh stored titles/thumbnails. The result contains
 * only channels you currently subscribe to, so a channel you've unsubscribed
 * from stops being fetched and shown — but its stored filter doc is left in
 * Firestore untouched, so resubscribing restores your regex/enabled choices.
 */
export async function syncSubscriptions(
  userId: string,
  subscriptions: Subscription[],
  existing: Map<string, ChannelFilter>,
): Promise<Map<string, ChannelFilter>> {
  const merged = new Map<string, ChannelFilter>();
  const writes: Array<Promise<void>> = [];
  for (const subscription of subscriptions) {
    const prior = existing.get(subscription.channelId);
    if (prior) {
      if (
        prior.title !== subscription.title ||
        prior.thumbnail !== subscription.thumbnail
      ) {
        const updated: ChannelFilter = {
          ...prior,
          title: subscription.title,
          thumbnail: subscription.thumbnail,
        };
        merged.set(subscription.channelId, updated);
        writes.push(
          saveChannelIdentity(userId, subscription.channelId, {
            title: subscription.title,
            thumbnail: subscription.thumbnail,
          }),
        );
      } else {
        merged.set(subscription.channelId, prior);
      }
    } else {
      const fresh: ChannelFilter = {
        channelId: subscription.channelId,
        title: subscription.title,
        thumbnail: subscription.thumbnail,
        enabled: true,
        regex: "",
        mode: "include",
      };
      merged.set(subscription.channelId, fresh);
      writes.push(saveChannelFilter(userId, fresh));
    }
  }
  await Promise.all(writes);
  return merged;
}

// Firestore caps an `in` query at 30 values, so membership lookups batch.
const WATCHED_QUERY_CHUNK = 30;

/**
 * Return the subset of the given video ids the user has watched. Scoping the
 * lookup to the loaded feed (rather than reading the whole watched collection)
 * keeps the read O(feed window) instead of O(lifetime history).
 */
export async function loadWatchedFor(
  userId: string,
  videoIds: string[],
): Promise<Set<string>> {
  const watched = new Set<string>();
  const unique = Array.from(new Set(videoIds));
  const chunks: string[][] = [];
  for (let start = 0; start < unique.length; start += WATCHED_QUERY_CHUNK) {
    chunks.push(unique.slice(start, start + WATCHED_QUERY_CHUNK));
  }
  await Promise.all(
    chunks.map(async (chunk) => {
      const snapshot = await getDocs(
        query(watchedCollection(userId), where(documentId(), "in", chunk)),
      );
      snapshot.forEach((document) => {
        watched.add(document.id);
      });
    }),
  );
  return watched;
}

export async function markWatched(
  userId: string,
  videoId: string,
): Promise<void> {
  await setDoc(doc(watchedCollection(userId), videoId), {
    watchedAt: Date.now(),
  });
}

export async function unmarkWatched(
  userId: string,
  videoId: string,
): Promise<void> {
  await deleteDoc(doc(watchedCollection(userId), videoId));
}
