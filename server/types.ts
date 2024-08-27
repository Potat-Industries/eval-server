
export interface EvalResponse {
  data: any[];
  statusCode: number;
  duration: number;
  errors?: { message: string }[];
  /** used for Eval over WebSocket */
  id?: number;
}

export type EvalRequestHandler = (code: string, msg: any) => Promise<EvalResponse>;
