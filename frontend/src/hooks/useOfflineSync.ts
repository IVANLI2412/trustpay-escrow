'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/** Represents a queued offline operation (draft save, submission, etc.). */
export interface OfflineQueueItem {
  id: string;
  /** Human-readable description of the operation (e.g. "Save draft: Build Decentralized Escrow UI"). */
  description: string;
  /** The HTTP method of the queued request. */
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** The API endpoint path (e.g. "/api/projects/123/milestones"). */
  url: string;
  /** JSON payload that will be sent when retrying. */
  payload: unknown;
  /** ISO timestamp when the item was queued. */
  queuedAt: string;
  /** Approximate serialized payload size in bytes. */
  payloadSize: number;
  /** Number of retry attempts so far. */
  retryCount: number;
  /** Optional tag for filtering/grouping (e.g. "draft", "submission", "approval"). */
  tag?: string;
}

const STORAGE_KEY = 'trustpay-offline-queue';
const MAX_QUEUE_SIZE = 100;
const RETRY_DELAY_MS = 2000;

/** Hook for managing the offline queue persisted in localStorage. */
export function useOfflineSync() {
  const [queue, setQueue] = useState<OfflineQueueItem[]>([]);
  const [isOnline, setIsOnline] = useState(true);
  const [processing, setProcessing] = useState(false);
  const onlineRef = useRef(true);

  // Initialize from localStorage on mount
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as OfflineQueueItem[];
        if (Array.isArray(parsed)) {
          setQueue(parsed.slice(-MAX_QUEUE_SIZE));
        }
      }
    } catch {
      // Ignore corrupted storage
    }

    // Online/offline detection
    const handleOnline = () => {
      setIsOnline(true);
      onlineRef.current = true;
      void flushQueue();
    };
    const handleOffline = () => {
      setIsOnline(false);
      onlineRef.current = false;
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Initial online state
    setIsOnline(navigator.onLine);
    onlineRef.current = navigator.onLine;

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Persist queue to localStorage whenever it changes
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
    } catch {
      // Storage full or unavailable
    }
  }, [queue]);

  /** Add a new item to the offline queue. */
  const enqueue = useCallback((
    description: string,
    method: OfflineQueueItem['method'],
    url: string,
    payload: unknown,
    tag?: string
  ) => {
    const item: OfflineQueueItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      description,
      method,
      url,
      payload,
      queuedAt: new Date().toISOString(),
      payloadSize: new TextEncoder().encode(JSON.stringify(payload)).length,
      retryCount: 0,
      tag,
    };
    setQueue((prev) => [...prev.slice(-(MAX_QUEUE_SIZE - 1)), item]);
    return item.id;
  }, []);

  /** Remove a specific item from the queue. */
  const discard = useCallback((id: string) => {
    setQueue((prev) => prev.filter((item) => item.id !== id));
  }, []);

  /** Clear the entire queue. */
  const clear = useCallback(() => {
    setQueue([]);
  }, []);

  /** Retry a specific item immediately. */
  const retry = useCallback(async (id: string): Promise<boolean> => {
    const item = queue.find((i) => i.id === id);
    if (!item) return false;

    setProcessing(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
      const res = await fetch(`${apiUrl}${item.url}`, {
        method: item.method,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(item.payload),
      });

      if (res.ok) {
        discard(id);
        return true;
      } else {
        // Increment retry count on failure
        setQueue((prev) =>
          prev.map((i) =>
            i.id === id ? { ...i, retryCount: i.retryCount + 1 } : i
          )
        );
        return false;
      }
    } catch {
      setQueue((prev) =>
        prev.map((i) =>
          i.id === id ? { ...i, retryCount: i.retryCount + 1 } : i
        )
      );
      return false;
    } finally {
      setProcessing(false);
    }
  }, [queue, discard]);

  /** Flush all pending items when coming back online. */
  const flushQueue = useCallback(async () => {
    if (!onlineRef.current || processing) return;

    const items = queue.filter((i) => i.retryCount < 5); // Max 5 retries
    for (const item of items) {
      if (!onlineRef.current) break;
      await retry(item.id);
      // Small delay between retries to avoid overwhelming the server
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }, [queue, retry]);

  // Auto-flush when coming online
  useEffect(() => {
    if (isOnline && queue.length > 0) {
      void flushQueue();
    }
  }, [isOnline, queue.length, flushQueue]);

  return {
    queue,
    isOnline,
    processing,
    enqueue,
    discard,
    clear,
    retry,
    flushQueue,
    pendingCount: queue.length,
  };
}

export default useOfflineSync;