import Logger from '../util/logger.js';
import Cluster from 'node:cluster';

interface PotatWorkerRequest<T extends (...args: any) => any> {
  type: 'PotatWorkerRequest';
  args: Parameters<T>;
  id: number;
}

interface PotatWorkerResponse<T extends (...args: any)=> any> {
  type: 'PotatWorkerResponse';
  result?: ReturnType<T>;
  error?: Error;
  id: number;
}

interface PotatCommandRequest {
  type: 'PotatCommandRequest';
  commandName: string;
  args: any[];
  msg: Record<string, any>;
  id: string;
}

export interface PotatCommandResponse {
  type: 'PotatCommandResponse';
  id: string;
  result?: any;
  error?: string;
}

type PotatWorkerMessage<T  extends (...args: any)=> any> = 
  | PotatWorkerRequest<T>
  | PotatWorkerResponse<T>
  | PotatCommandRequest 
  | PotatCommandResponse;

type PotatRequestHandlerCallback<T extends (...args: any) => any> = (error: Error | undefined, m?: ReturnType<T> | undefined) => void;

export class PotatWorker<T extends (...args: any) => any> {
  private requestsHandler: ((
    args: Parameters<T>,
    callback: PotatRequestHandlerCallback<T>
  ) => void) | undefined;

  private readonly workerHandler: T;
  public readonly workerTimeOut: number;
  private readonly workerExecutionTimeout: number;

  private id = 0;

  private queueSizeValue: { value: number } | undefined;

  public get isReady() {
    return typeof this.requestsHandler === 'function';
  }

  public get queueSize() {
    return this.queueSizeValue?.value ?? 0;
  }

  constructor(
    workerHandler: T,
    workerTimeOut: number, 
    workerExecutionTimeout: number) {

    this.workerHandler = workerHandler;
    this.workerTimeOut = workerTimeOut;
    this.workerExecutionTimeout = workerExecutionTimeout;

    if (Cluster.isPrimary) {
      this.keepWorkerAlive();
    } else {
      this.worker();
    }

    this.add = this.add.bind(this);
  }

  public async add(...args: Parameters<T>): Promise<ReturnType<T>> {
    if (Cluster.isWorker) {
      return this.workerHandler(...args);
    }

    let queueSizeObject: typeof this.queueSizeValue = { value: 0 };

    return new Promise<ReturnType<T>>((resolve, reject) => {
      queueSizeObject = this.queueSizeValue;
      if (queueSizeObject?.value) {
        queueSizeObject.value++;
      }

      const tm = setTimeout(() => {
        reject(new Error('Worker execution timed out.'));
      }, this.workerExecutionTimeout);

      if (!this.isReady) {
        return reject(new Error('Worker is not ready.'));
      }

      const watcher = (error: Error | undefined, m: ReturnType<T> | undefined) => {
        if (error) {
          reject(error);
        } else if (m !== undefined) {
          resolve(m);
        } else {
          reject(new Error('Unexpected undefined result.'));
        }
        clearTimeout(tm);
      };

      this.requestsHandler!(args, watcher as PotatRequestHandlerCallback<T>);
    }).finally(() => {
      if (queueSizeObject?.value) {
        queueSizeObject.value--;
      }
    });
  }

  private worker() {
    process.on('message', async (m: PotatWorkerMessage<T>) => {
      if (m.type === 'PotatWorkerRequest') {
        try {
          const result = await this.workerHandler(...(m.args ?? []));

          process.send?.({
            type: 'PotatWorkerResponse',
            id: m.id,
            result,
          });
        } catch (error) {
          process.send?.({
            type: 'PotatWorkerResponse',
            id: m.id,
            error,
          });
        }
      }
    });
  }


  private async keepWorkerAlive() {
    while (true) {
      try {
        const abortController = new AbortController();
        const worker = Cluster.fork();
        const callbacks = new Map<number, PotatRequestHandlerCallback<T>>();
        let lastRequest = 0;
        let lastResponse = 0;

        this.queueSizeValue = { value: 0 };
        this.requestsHandler = (args: Parameters<T>, callback: PotatRequestHandlerCallback<T>) => {
          const id = this.id++;

          // didn't receive a response for more than 1 minute
          if (lastRequest > lastResponse && Date.now() - lastRequest > 6e4) {
            abortController.abort();

            return callback(new Error('Worker is not responding.'), undefined);
          }

          worker.send({ type: 'PotatWorkerRequest', args, id });
          lastRequest = Date.now();

          callbacks.set(id, callback);
        };

        worker.addListener('message', (m: PotatWorkerResponse<T>) => {
          if (m.type === 'PotatWorkerResponse') {
            lastResponse = Date.now();

            const cb = callbacks.get(m.id);

            if (m.error) {
              return cb?.(m.error);
            }

            return cb?.(undefined, m.result);
          }
        });

        await new Promise<void>(async (resolve, reject) => {
          worker?.on('exit', (code) => {
            if (code === 0) {
              resolve();
            } else {
              reject('Worker exited with code ' + code);
            }
          });

          worker?.on('error', reject);

          abortController.signal.addEventListener('abort', () => {
            try {
              Logger.warn('Worker is not responding. Killing...');
              reject(new Error('Worker is not responding.'));
              worker.kill('SIGKILL');
            } catch (e) {
              Logger.error('Failed to kill worker', (e as Error)?.message);
            }
          });
        });

        this.requestsHandler = undefined;
      } catch (e) {
        Logger.error('Worker died', (e as Error)?.message);
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
      Logger.error('Forking new worker...');
    }
  }
}
