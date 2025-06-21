import cluster from 'cluster';
import { PotatWorker } from './worker.js';

export interface PotatWorkersPoolSettings {
  maxQueueSizePerWorker: number;

  workerTimeOut: number;
  workerExecutionTimeout: number;
}

export class PotatWorkersPool<T extends (...args: any) => any> {
  private workers: PotatWorker<T>[] = [];

  private readonly settings: PotatWorkersPoolSettings;

  public constructor(
    workerHandler: T,
    size: number,
    settings: PotatWorkersPoolSettings,
  ) {
    this.settings = settings;

    if (cluster.isPrimary) {
      for (let i = 0; i < size; i++) {
        this.workers.push(new PotatWorker(workerHandler, settings.workerTimeOut, settings.workerExecutionTimeout));
      }
    } else {
      new PotatWorker(workerHandler, settings.workerTimeOut, settings.workerExecutionTimeout);
    }
  }

  public add(...args: Parameters<T>): Promise<ReturnType<T>> {
    if (!cluster.isPrimary) {
      throw new Error('PotatWorkersPool can only be used in the primary process.');
    }

    const worker = this.pickWorker();

    return worker.add(...args);
  }

  private pickWorker() {
    const worker = this.workers
      .filter(w => w.isReady && w.queueSize < this.settings.maxQueueSizePerWorker)
      .sort((a, b) => a.queueSize - b.queueSize)[0];

    if (!worker) {
      throw new Error('The queue is full.');
    }

    return worker;
  }
}
