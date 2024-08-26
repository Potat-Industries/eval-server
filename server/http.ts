import express, {
  Request,
  Response,
  Application,
  NextFunction,
  json,
} from "express";
import { timingSafeEqual } from "crypto";
import { Evaluator, Config } from "../index.js";

interface EvalResponse {
  data: any[];
  statusCode: number;
  duration: number;
  errors?: { message: string }[];
}

export class EvalServer {
  private static instance: EvalServer;
  private server: Application;

  private readonly PORT: number;
  private readonly AUTHORIZATION: string;
  private evaluator: Evaluator;

  private constructor(config: Config) {
    if (!config.port) {
      console.error('No HTTP port provided. (Required)');
      process.exit(1);
    }

    this.PORT = config.port;
    this.AUTHORIZATION = config.auth;
    this.evaluator = Evaluator.new(config);
    this.server = express();
    this.server.use(json());
    this.setupRoute();
  }

  public static new(config: Config): EvalServer {
    return this.instance ?? (this.instance = new this(config));
  }

  private setupRoute() {
    this.server.post(
      "/eval",
      this.authenticate.bind(this),
      async (req: Request, res: Response) => {
        const start = performance.now();

        if (!req.body.code || typeof req.body.code !== "string") {
          return res.status(400).send({
            data: [],
            duration: parseFloat((performance.now() - start).toFixed(4)),
            errors: [{
              message: typeof req.body.code !== "string" ? "Invalid code" : "Missing code"
            }],
          } as EvalResponse);
        }

        if (req.body.msg && typeof req.body.msg !== "object") {
          return res.status(400).send({
            data: [],
            duration: parseFloat((performance.now() - start).toFixed(4)),
            errors: [{ message: "Invalid message" }],
          } as EvalResponse);
        }

        try {
          const result = await this.evaluator.add(req.body.code,  req.body.msg);

          res.status(200).send({
            data: [String(result)],
            statusCode: 200,
            duration: parseFloat((performance.now() - start).toFixed(4)),
          } as EvalResponse);
        } catch (e) {
          console.error(e);

          res.status(500).send({
            data: [],
            duration: parseFloat((performance.now() - start).toFixed(4)),
            errors: [{ message: "Internal server error" }],
          })
        }
      }
    );

    this.startServer();
  }

  private authenticate(req: Request, res: Response, next: NextFunction) {
    const posessed = Buffer.alloc(5, this.AUTHORIZATION)
    const provided = Buffer.alloc(5, req.headers.authorization?.replace("Bearer ", ""))

    if (!timingSafeEqual(posessed, provided)) {
      return res.status(418).send({
        data: [],
        statusCode: 418,
        duration: 0,
        errors: [{ message: "not today my little bish xqcL" }],
      } as EvalResponse);
    }

    next();
  }

  private startServer() {
    this.server.listen(this.PORT, () => {
      console.log(`EvalServer listening on port ${this.PORT}`);
    });
  }
}
