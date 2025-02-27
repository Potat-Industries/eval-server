import IsolatedVM from "isolated-vm";

export class Utils {
  static instance: Utils;

  private constructor() {}

  public static async inject(
    context: IsolatedVM.Reference<Record<string | number | symbol, any>>
  ): Promise<void> {
    const _this = this.instance ?? (this.instance = new this());
    const thisClass = Object.getOwnPropertyNames(this.prototype);
    for (const method of thisClass) {
      if (method === 'constructor') {
        continue;
      }
      await context.set(method, _this[method]);
    }
  }

  public randomString(length: number): string {
    let text = '';
    const possible =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < length; i += 1) {
      text += possible.charAt(~~(Math.random() * possible.length));
    }
    return text;
  }

  public atob(str: string): string {
    return atob(str);
  }

  public btoa(str: string): string {
    return btoa(str);
  }

  public randomSlice(array: any[], size: number): any[] {
    return this.shuffleArray(array).slice(0, size);
  }

  public splitArray(arr: any[], len: number): any[] {
    if (!Array.isArray(arr) || arr.length <= 1) {
      return [arr];
    }

    const chunks: any[] = [];
    let i = 0;
    const n = arr.length;

    while (i < n) {
      chunks.push(arr.slice(i, (i += len)));
    }

    return chunks;
  }

  public shuffleArray<T>(array: T[]): T[] {
    for (let i = array.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  public shuffleString(str: string): string {
    const chars = str.split('');
    for (let i = chars.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
  }

  public randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
}