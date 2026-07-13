import {
  collection,
  doc,
  documentId,
  onSnapshot,
  query,
  setDoc,
  type Unsubscribe,
  where,
} from "firebase/firestore";
import { firestoreDb } from "./firebase-app";
import type { FeedItem } from "./types";

/**
 * Shorts are capped at 3 minutes, so a longer video can't be one — the feed uses
 * this to avoid classifying videos that are provably not Shorts.
 */
export const SHORTS_MAX_SECONDS = 180;

/** Firestore caps an `in` query at 30 values, so verdict lookups batch. */
const VERDICT_QUERY_CHUNK = 30;

/** Whether a video could be a Short at all, and so is worth classifying. */
export function isShortsCandidate(item: FeedItem): boolean {
  return (
    item.kind === "video" &&
    !!item.durationSeconds &&
    item.durationSeconds <= SHORTS_MAX_SECONDS
  );
}

function videoMetaCollection() {
  return collection(firestoreDb(), "videoMeta");
}

/**
 * Watch the Shorts verdicts for the given video ids. Short-ness isn't
 * user-specific and never changes, so verdicts live in one global collection
 * every user reads. Ids with no document are reported separately, as nobody
 * having asked about them — a document exists as soon as anyone has.
 */
export function watchShortsVerdicts(
  videoIds: string[],
  onVerdicts: (verdicts: Map<string, boolean>, missing: string[]) => void,
): Unsubscribe {
  const chunks: string[][] = [];
  const unique = Array.from(new Set(videoIds));
  for (let start = 0; start < unique.length; start += VERDICT_QUERY_CHUNK) {
    chunks.push(unique.slice(start, start + VERDICT_QUERY_CHUNK));
  }
  const listeners = chunks.map((chunk) =>
    onSnapshot(
      query(videoMetaCollection(), where(documentId(), "in", chunk)),
      (snapshot) => {
        const verdicts = new Map<string, boolean>();
        const present = new Set<string>();
        snapshot.forEach((document) => {
          present.add(document.id);
          const isShort = document.get("isShort") as boolean | undefined;
          // null means asked but not yet probed — present, but no verdict
          if (typeof isShort === "boolean") {
            verdicts.set(document.id, isShort);
          }
        });
        // Absent from the local cache means unsynced, not unasked: the first
        // snapshot of a listener is served from cache before the server answers,
        // and treating it as authoritative would ask about videos already
        // classified. Verdicts it does hold are still good — they never change.
        const missing = snapshot.metadata.fromCache
          ? []
          : chunk.filter((videoId) => !present.has(videoId));
        onVerdicts(verdicts, missing);
      },
    ),
  );
  return () => {
    for (const unsubscribe of listeners) {
      unsubscribe();
    }
  };
}

/**
 * Ids asked about in this session. An inconclusive probe deletes the document,
 * which is indistinguishable from nobody having asked, so without this a
 * request -> probe -> delete cycle would repeat forever.
 */
const requested = new Set<string>();

/**
 * Ask about videos nobody has classified. Creating the document is the request:
 * it fires the backend trigger, and the null verdict is what puts the video in the
 * queue that trigger drains (Firestore can't query for an absent field). The rules
 * permit only this shape, so a client can never write a verdict.
 */
export async function requestShortsClassification(
  videoIds: string[],
): Promise<void> {
  const fresh = videoIds.filter((videoId) => !requested.has(videoId));
  for (const videoId of fresh) {
    requested.add(videoId);
  }
  await Promise.all(
    fresh.map(async (videoId) => {
      try {
        await setDoc(doc(videoMetaCollection(), videoId), {
          requestedAt: Date.now(),
          isShort: null,
        });
      } catch {
        // someone else asked first (an update, which the rules refuse), or offline
      }
    }),
  );
}
