import { apiGetPhoto } from '../api';

interface QueueJob {
  photoId: string;
  session: string;
  resolve: (dataUrl: string | null) => void;
}

/**
 * Sequential 1-at-a-time thumbnail loader queue for getPhoto(..., 'edited').
 * Prevents concurrent Apps Script rate limits and supports instant cancellation
 * when switching reports.
 */
export class PhotoThumbnailQueue {
  private queue: QueueJob[] = [];
  private inFlight = new Map<string, Promise<string | null>>();
  private cache = new Map<string, string>();
  private running = false;
  private generation = 0;

  getCached(photoId: string): string | undefined {
    return this.cache.get(photoId);
  }

  setCached(photoId: string, dataUrl: string): void {
    this.cache.set(photoId, dataUrl);
  }

  removeCached(photoId: string): void {
    this.cache.delete(photoId);
  }

  clear(): void {
    this.generation += 1;
    const pending = this.queue.splice(0, this.queue.length);
    for (const job of pending) {
      job.resolve(null);
    }
    this.inFlight.clear();
    this.cache.clear();
    this.running = false;
  }

  enqueue(session: string, photoId: string): Promise<string | null> {
    const cached = this.cache.get(photoId);
    if (cached) {
      return Promise.resolve(cached);
    }
    const existing = this.inFlight.get(photoId);
    if (existing) {
      return existing;
    }

    const promise = new Promise<string | null>((resolve) => {
      this.queue.push({ photoId, session, resolve });
      this.pump();
    });

    this.inFlight.set(photoId, promise);
    return promise;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const gen = this.generation;

    while (this.queue.length > 0 && this.generation === gen) {
      const job = this.queue.shift()!;
      const cached = this.cache.get(job.photoId);
      if (cached) {
        this.inFlight.delete(job.photoId);
        job.resolve(cached);
        continue;
      }

      try {
        const res = await apiGetPhoto(job.session, job.photoId, 'edited');
        if (this.generation !== gen) {
          job.resolve(null);
          return;
        }
        if (res.data) {
          const mime = res.mime || 'image/jpeg';
          const dataUrl = res.data.startsWith('data:')
            ? res.data
            : `data:${mime};base64,${res.data}`;
          this.cache.set(job.photoId, dataUrl);
          this.inFlight.delete(job.photoId);
          job.resolve(dataUrl);
        } else {
          this.inFlight.delete(job.photoId);
          job.resolve(null);
        }
      } catch {
        this.inFlight.delete(job.photoId);
        job.resolve(null);
      }
    }

    if (this.generation === gen) {
      this.running = false;
    }
  }
}
