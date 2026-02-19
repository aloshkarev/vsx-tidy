import * as readline from "readline";
import { ChildProcessWithoutNullStreams } from "child_process";

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

type NotificationHandler = (method: string, params: unknown) => void;

export class JsonRpcConnection {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<JsonRpcId, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private onNotificationHandler: NotificationHandler | null = null;

  constructor(proc: ChildProcessWithoutNullStreams) {
    this.proc = proc;
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let msg: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        this.onNotificationHandler?.("log", {
          level: "error",
          message: `Failed to parse JSON: ${(err as Error).message}`,
        });
        return;
      }

      if ("id" in msg && ("result" in msg || "error" in msg)) {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        if (msg.error) {
          entry.reject(new Error(msg.error.message));
        } else {
          entry.resolve(msg.result);
        }
        return;
      }

      if ("method" in msg) {
        this.onNotificationHandler?.(msg.method, msg.params);
      }
    });

    proc.stderr.on("data", (buf) => {
      this.onNotificationHandler?.("log", {
        level: "error",
        message: buf.toString(),
      });
    });

    proc.on("exit", (code, signal) => {
      for (const [, entry] of this.pending) {
        entry.reject(new Error(`Daemon exited: code=${code} signal=${signal}`));
      }
      this.pending.clear();
    });
  }

  onNotification(handler: NotificationHandler) {
    this.onNotificationHandler = handler;
  }

  private writeLine(payload: string): boolean {
    if (!this.proc.stdin.writable) {
      this.onNotificationHandler?.("log", {
        level: "error",
        message: "Daemon stdin is not writable.",
      });
      return false;
    }
    try {
      this.proc.stdin.write(payload + "\n");
      return true;
    } catch (err) {
      this.onNotificationHandler?.("log", {
        level: "error",
        message: `Failed to write to daemon stdin: ${(err as Error).message}`,
      });
      return false;
    }
  }

  sendRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    if (!this.writeLine(JSON.stringify(req))) {
      return Promise.reject(new Error("Daemon is not available."));
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
  }

  sendNotification(method: string, params?: unknown) {
    const note: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.writeLine(JSON.stringify(note));
  }

  dispose() {
    this.proc.kill();
  }
}
