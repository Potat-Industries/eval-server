import IsolatedVM from "isolated-vm";
export declare class Utils {
    static instance: Utils;
    private constructor();
    static inject(context: IsolatedVM.Reference<Record<string | number | symbol, any>>): Promise<void>;
    randomString(length: number): string;
    randomSlice(array: any[], size: number): any[];
    splitArray(arr: any[], len: number): any[];
    shuffleArray(array: any[]): any[];
    shuffleString(str: string): string;
    randomInt(min: number, max: number): number;
    removeDuplicates(arr: any[]): any[];
    atob(str: string): string;
    btoa(str: string): string;
}
